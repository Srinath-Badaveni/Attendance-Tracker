const puppeteer = require("puppeteer");
const nodemailer = require("nodemailer");
require('dotenv').config(); 

async function runSync() {
    // 1. Get credentials from environment
    const rollNo = process.env.ROLL_NO;
    const emailUser = process.env.EMAIL_USER;
    const emailPass = process.env.EMAIL_PASS;
    const recipient = process.env.RECIPIENT_EMAIL;

    // 2. Setup Launch Options
    const isGitHubAction = process.env.GITHUB_ACTIONS === 'true';
    
    const launchOptions = {
        headless: "new",
        args: [
            "--no-sandbox", 
            "--disable-setuid-sandbox",
            "--disable-dev-shm-usage",
            "--disable-gpu"
        ]
    };

    // If running locally on Windows, point to your Chrome
    if (!isGitHubAction) {
        launchOptions.executablePath = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
    }

    const browser = await puppeteer.launch(launchOptions);

    try {
        console.log(`Starting sync for Roll No: ${rollNo}...`);
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
        console.log("Login successful.");

        const delay = (ms) => new Promise(res => setTimeout(res, ms));

        // 2. Open attendance page
        await page.goto("http://103.171.190.44/TKRCET/StudentInformationForStudent.php", { waitUntil: "domcontentloaded" });
        await delay(5000); // Increased delay for slower server response

        // 3. Extract Data
        const attendanceData = await page.evaluate(() => {
            const allTables = Array.from(document.querySelectorAll("table.darker-border-table"));
            const reportTable = allTables.find(t => t.innerText.includes("Subject Abrevation"));
            const daywiseTable = allTables.find(t => t.innerText.includes("Daywise Detailed Attendance"));

            if (!reportTable) return null;

            const nameEl = Array.from(document.querySelectorAll('p')).find(p => p.innerText.includes("Name:"));
            const studentName = nameEl ? nameEl.innerText.split("Name:")[1]?.trim() : "Student";

            let latestDayInfo = { date: "", day: "", periods: [] };
            if (daywiseTable) {
                const rows = Array.from(daywiseTable.querySelectorAll("tbody tr"));
                const dataRow = rows.find(r => /\d{2}-\d{2}-\d{4}/.test(r.innerText));

                if (dataRow) {
                    const cells = Array.from(dataRow.querySelectorAll("td"));
                    latestDayInfo.date = cells[0]?.innerText.trim();
                    latestDayInfo.day = cells[1]?.innerText.trim();

                    for (let i = 2; i < cells.length; i++) {
                        const text = cells[i].innerText.replace(/\s+/g, ' ').trim();
                        const span = cells[i].colSpan || 1;
                        for (let s = 0; s < span; s++) {
                            latestDayInfo.periods.push(text || "--");
                        }
                    }
                    latestDayInfo.periods = latestDayInfo.periods.slice(0, 6);
                }
            }

            const statsRow = Array.from(reportTable.querySelectorAll("tbody tr")).find(r => r.innerText.includes("Attendance"));
            const c = statsRow ? Array.from(statsRow.querySelectorAll("td")) : [];

            return {
                studentName,
                latestDayInfo,
                summary: {
                    conducted: c[12]?.innerText.trim(),
                    present: c[13]?.innerText.trim(),
                    absent: c[14]?.innerText.trim(),
                    percentage: c[15]?.innerText.trim()
                }
            };
        });

        if (!attendanceData) {
            throw new Error("Could not find attendance tables. Portal might be down or layout changed.");
        }

        // 4. Send the email
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
                   <p>Your current aggregate attendance is <b>${attendanceData.summary.percentage}</b>.</p>
                   <p><b>Summary:</b> Present: ${attendanceData.summary.present} | Absent: ${attendanceData.summary.absent} | Total: ${attendanceData.summary.conducted}</p>
                   <hr>
                   <h4>Daily Timeline (${latestDay.date || 'N/A'} - ${latestDay.day || 'N/A'})</h4>
                   <ul>${periodsHtml}</ul>`
        });

        console.log("Success: Email Sent!");
    } catch (error) {
        console.error("AGENT CRASH REPORT:");
        console.error(error.message);
        process.exit(1); 
    } finally {
        await browser.close();
    }
}

runSync();