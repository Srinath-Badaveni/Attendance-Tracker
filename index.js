const puppeteer = require("puppeteer");
const nodemailer = require("nodemailer");
require('dotenv').config(); // Loads variables from .env when running locally
async function runSync() {
    // 1. Get credentials from environment (GitHub Secrets)
    const rollNo = process.env.ROLL_NO;
    const emailUser = process.env.EMAIL_USER;
    const emailPass = process.env.EMAIL_PASS;
    const recipient = process.env.RECIPIENT_EMAIL;

    // const launchOptions = {
    //     headless: "new",
    //     args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-blink-features=AutomationControlled"]
    // };

    // If running locally (not in GitHub Actions), use local Chrome to avoid ERR_BLOCKED_BY_CLIENT
    if (process.env.GITHUB_ACTIONS !== 'true') {
        launchOptions.executablePath = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
    }

    const browser = await puppeteer.launch({
    headless: "new",
    args: [
        "--no-sandbox", 
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage", // Fixes most "Exit Code 1" crashes on Linux
        "--disable-gpu"
    ]
});

    try {
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

        const delay = (ms) => new Promise(res => setTimeout(res, ms));

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

            // 3. Extract Latest Day Info
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

        if (!attendanceData) {
            throw new Error("Attendance data structure mismatch.");
        }

        // After scraping, send the email
        let transporter = nodemailer.createTransport({
            service: 'gmail',
            auth: { user: emailUser, pass: emailPass }
        });

        const latestDay = attendanceData.latestDayInfo;
        const periodsHtml = latestDay.periods.map((p, i) => `<li>Period ${i + 1}: <b>${p}</b></li>`).join('');

        await transporter.sendMail({
            from: `"TKR Sync Agent" <${emailUser}>`,
            to: recipient,
            subject: `Attendance Update: ${attendanceData.summary.percentage}`,
            html: `<h3>Hi ${attendanceData.studentName},</h3>
                   <p>Your attendance for today is <b>${attendanceData.summary.percentage}</b>.</p>
                   <p>Present: ${attendanceData.summary.present} | Absent: ${attendanceData.summary.absent}</p>
                   <hr>
                   <h4>Latest Day Info (${latestDay.date} - ${latestDay.day})</h4>
                   <ul>
                       ${periodsHtml}
                   </ul>`
        });

        console.log("Sync Complete and Email Sent!");
    } catch (error) {
        console.error("Agent Error:", error);
        process.exit(1); // Tell GitHub it failed
    } finally {
        await browser.close();
    }
}

runSync();
