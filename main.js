const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const puppeteer = require("puppeteer");

const delay = (ms) => new Promise(res => setTimeout(res, ms));

const createWindow = () => {
    const mainWindow = new BrowserWindow({
        width: 1200,
        height: 800,
        backgroundColor: '#f8fafc',
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            // Security best practices:
            nodeIntegration: false,
            contextIsolation: true
        }
    });

    mainWindow.loadFile('index.html');
};

app.whenReady().then(() => {
    createWindow();

    app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
});

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
});

// IPC handler for web scraping
ipcMain.handle("sync-attendance", async (event, rollNo) => {
    if (!rollNo) throw new Error("Roll Number is required");

    console.log(`Accessing portal for: ${rollNo}`);

    let browser;
    try {
        // We use bundled chrome if possible or fall back to installed chrome.
        // For electron apps, the easiest way to package puppeteer is usually omitting executablePath,
        // but since this is an electron app, we probably want to use puppeteer correctly.
        // Usually, `puppeteer` downloads Chrome into node_modules.
        browser = await puppeteer.launch({
            headless: "new",
            executablePath: "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
            args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-blink-features=AutomationControlled"]
        });

        const page = await browser.newPage();
        await page.setUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36");

        // 1. Login
        await page.goto("http://103.171.190.44/TKRCET/", { waitUntil: "networkidle2", timeout: 60000 });
        await page.type("#username", rollNo, { delay: 20 });
        await page.type("#password", rollNo, { delay: 20 });
        await Promise.all([
            page.click('button[type="submit"]'),
            page.waitForNavigation({ waitUntil: "networkidle2" })
        ]);

        // 2. Open attendance page
        await page.goto("http://103.171.190.44/TKRCET/StudentInformationForStudent.php", { waitUntil: "domcontentloaded" });
        await delay(3000);

        // 3. Extract Data
        const attendanceData = await page.evaluate(() => {
            // 1. Helper to find the correct table by its title text
            const allTables = Array.from(document.querySelectorAll("table.darker-border-table"));

            // Find the report table (Overall Stats)
            const reportTable = allTables.find(t => t.innerText.includes("Subject Abrevation"));

            // Find the Daywise table specifically
            const daywiseTable = allTables.find(t => {
                const prevElement = t.previousElementSibling;
                return t.innerText.includes("Daywise Detailed Attendance") ||
                    (prevElement && prevElement.innerText.includes("Daywise Detailed Attendance"));
            });

            // 2. Extract Student Name
            const nameEl = Array.from(document.querySelectorAll('p')).find(p => p.innerText.includes("Name:"));
            const studentName = nameEl ? nameEl.innerText.split("Name:")[1]?.trim() : "Student";

            // 3. Extract Latest Day Info (e.g., 30-03-2026)
            let latestDayInfo = { date: "", day: "", periods: [] };
            if (daywiseTable) {
                const rows = Array.from(daywiseTable.querySelectorAll("tbody tr"));
                // Look for the first row that actually contains a date pattern
                const dataRow = rows.find(r => /\d{2}-\d{2}-\d{4}/.test(r.innerText));

                if (dataRow) {
                    const cells = Array.from(dataRow.querySelectorAll("td"));
                    latestDayInfo.date = cells[0]?.innerText.trim();
                    latestDayInfo.day = cells[1]?.innerText.trim();

                    // Handle colspans (e.g., the "Absent (CRT)" spanning 3 periods)
                    for (let i = 2; i < cells.length; i++) {
                        const text = cells[i].innerText.replace(/\s+/g, ' ').trim();
                        const span = cells[i].colSpan || 1;
                        for (let s = 0; s < span; s++) {
                            latestDayInfo.periods.push(text || "--");
                        }
                    }
                    // Ensure we only have the 6 standard periods
                    latestDayInfo.periods = latestDayInfo.periods.slice(0, 6);
                }
            }

            // 4. Extract Summary Stats
            const statsRow = Array.from(reportTable.querySelectorAll("tbody tr")).find(r => r.innerText.includes("Attendance"));
            const c = statsRow ? Array.from(statsRow.querySelectorAll("td")) : [];

            return {
                studentName,
                latestDayInfo,
                subjects: {
                    DevOps: c[1]?.innerText.trim(),
                    CD: c[2]?.innerText.trim(),
                    ML: c[3]?.innerText.trim(),
                    FSD: c[4]?.innerText.trim(),
                    IoT: c[5]?.innerText.trim(),
                    DM: c[6]?.innerText.trim(),
                    DevOpsLab: c[7]?.innerText.trim(),
                    MLLab: c[8]?.innerText.trim(),
                    Library: c[9]?.innerText.trim(),
                    Mentoring: c[10]?.innerText.trim(),
                    CRT: c[11]?.innerText.trim()
                },
                summary: {
                    conducted: c[12]?.innerText.trim(),
                    present: c[13]?.innerText.trim(),
                    absent: c[14]?.innerText.trim(),
                    percentage: c[15]?.innerText.trim()
                }
            };
        });

        await browser.close();

        if (!attendanceData) {
            throw new Error("Attendance data structure mismatch.");
        }
        
        console.log(`Successfully retrieved data for: ${rollNo}`);
        return attendanceData;

    } catch (error) {
        if (browser) await browser.close();
        console.error("Critical Error:", error.message);
        throw error;
    }
});
