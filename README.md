# Attendance System

Teacher starts a session, students enter a rotating 6-digit code on their own phones.
Backend: Node.js + Express + SQLite. Frontend: one HTML page (public/index.html).

## Run it
1. Install Node.js 18 or newer.
2. In this folder run: `npm install` then `npm start`
3. The terminal prints addresses like `http://192.168.43.1:3000`. Open that on the teacher's
   device and on each student's phone (all on the same hotspot or Wi-Fi).

## Create an account
Choose Teacher or Student on the login screen and select **Sign Up** to create an account.
Teachers register with a teacher ID; students register with a roll number and class/division.
Both roles require a unique email address. After signup, log in with the registered ID or roll
number and password. Passwords are stored as bcrypt hashes. No demo accounts are created;
register an account before signing in.

## Settings (environment variables)
- `STRICT_NETWORK=1`  only accept students on the same network as the teacher (see below)
- `LATE_MIN=10`       minutes after start when check-ins count as Late
- `PORT=3000`

Example: `STRICT_NETWORK=1 npm start` (Windows PowerShell: `$env:STRICT_NETWORK=1; npm start`)

## Using it in a real classroom
- Run the server on the teacher's laptop, and connect the laptop to the teacher's phone hotspot
  (or the classroom Wi-Fi). Students join the same network.
- With STRICT_NETWORK=1 the teacher must open the site by the LAN address (not `localhost`),
  because the server records the teacher's address when the session starts.
- Put the site behind HTTPS before any use outside a classroom network.

## Files
- `server.js`        API, database, all attendance rules
- `public/index.html` login, teacher dashboard, student page
- `attendance.db`    created on first run (local data; do not commit)

## Ideas to add next
QR code (npm `qrcode`), WebSockets instead of polling, parent alerts, admin page for CSV student import,
selfie check, PWA install.
