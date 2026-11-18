# Edvitta

Edvitta is a booking app for tuition, a bit like Ola or Rapido but for tutors. Parents book verified tutors within 3 km for home classes, or any tutor for online classes. It covers school subjects, drawing, singing, dance, music, chess, yoga, coding and more.

It is one web app that installs on phones like an app (PWA). There are four logins: **Parent**, **Tutor**, **Admin** and **Staff**.

---

## Run it on your computer (5 minutes)

1. Install **Node.js 22.13 or newer** from https://nodejs.org (pick the LTS version).
2. Open Terminal in this folder and run:
   ```bash
   npm install
   npm run dev
   ```
3. Open **http://localhost:3000**

`npm run dev` loads demo data. Every demo account uses the password **Demo@1234**:

| Login | Email |
|---|---|
| Parent (has ₹5,000 in wallet, 2 children) | parent@demo.in |
| Second parent | parent2@demo.in |
| Tutor (verified, Maths/Science) | tutor@demo.in |
| Other verified tutors | tutor2@demo.in … tutor5@demo.in (music, dance, drawing, online English) |
| Tutor who hasn't done KYC yet | newtutor@demo.in |
| Staff (helpline, KYC, payments, SOS) | staff@demo.in |
| **Admin** | admin@edvitta.local / **Admin@12345** |

The demo tutors are in Koramangala, Bengaluru. To see them in the 3 km search, type "Koramangala" in the area box.

Run the automated checks with `npm test` (95 end-to-end checks).

---

## What's inside

### Parents
- Add children (name, class, age)
- **Find tutors within 3 km** of home on a map, or browse online tutors. Filter by subject or skill.
- **Book sessions**: one session, **daily**, or **custom weekdays** (for example Mon/Wed/Fri), with date range, time and duration
- See the price before paying, apply a **coupon**, pay from the **wallet**
- **Live tracking** of the tutor on a map while they are on the way and during class
- A **4-digit start code** for every home visit. The tutor can't start the session without it, which proves they actually arrived.
- **Join online class** button when the tutor shares a Meet or Zoom link
- Cancel at any time, and unused sessions are refunded to the wallet automatically
- Rate and review tutors, plus a red **SOS button** that alerts the safety team with your GPS location

### Tutors
- Register, set subjects and skills, fee per hour, home/online/both, and base location
- **Upload KYC**: Aadhaar front/back, PAN and photo are required. Qualification, police verification and address proof are optional.
- Can't go online or appear in search until **admin/staff approve** the KYC
- Online/offline switch, accept or decline requests, **send the online class link**
- "I'm on the way" button **shares phone GPS live** with that parent only
- Enter the parent's start code, then mark the session complete. **Payment lands in the wallet** (minus commission).
- Withdraw earnings to UPI

### Wallet and payments
- Wallet for every parent and tutor, with a full transaction history
- **Manual payment through the admin's UPI QR**: the user pays, enters the UTR number and can attach a screenshot. Staff check it against the bank and approve, and the wallet is credited. Duplicate UTRs are blocked.
- Online top-up runs in **demo mode** for testing (see "Going live")
- Booking money is **held** and released to the tutor only after each completed session

### Earning features
- **Commission** on every session (default 15%, change it in Settings)
- **Advertisement section**: ads show on the home, search, dashboard and community screens. Anyone can buy an ad slot from their wallet, and admin approves it (rejected ads are refunded). Admin can also add ads for outside advertisers. Impressions and clicks are counted.
- **Coupons**: % or flat off, maximum discount, minimum order, total uses, uses per person, expiry date
- **Referrals**: every user gets a code and a WhatsApp share link. Both people get wallet money when the friend's first booking is confirmed, or when a referred tutor is verified.

### Community (apartment groups)
- A parent creates a group, for example "Class 5 Maths, Prestige Acropolis", with a fee per child, maximum seats and a schedule
- Other parents nearby (or anyone searching the apartment name) **pay from their wallet to add their child**
- Fees are held safely. The creator picks a verified tutor, and the money (minus commission) goes to that tutor. If the group closes before a tutor is chosen, **everyone is refunded**.
- Only group members can see the names of the children in a group

### Admin panel
Dashboard (pending work, users, live sessions, GMV, payouts, ad revenue), KYC review with document viewer, UPI payment approval, withdrawals, helpline tickets, SOS alerts with a **live map of every home session**, all bookings, users (suspend/activate, adjust wallet), **staff accounts with permissions**, coupons, ads, community groups, settings (commission, radius, referral amounts, UPI ID, QR image upload, ad prices, new subjects and skills) and the **audit log**.

### Staff panel (customer helpline)
Staff log in at the same page. They see **only the sections the admin allows**: tickets, KYC, payments, SOS, bookings, ads, community or users. For tickets they can reply, add internal notes the customer can't see, set priority and assign tickets to a teammate. Safety tickets are marked urgent automatically.

### Added in version 2
- **Admin → Config** has on/off switches for everything below, the **platform commission %**, GST settings, Hostinger email, Razorpay keys, Exotel calls and video servers. Passwords and API secrets are stored encrypted and are never shown again.
- **Online payments (Razorpay) are OFF by default.** Until you switch them on, parents add money through your UPI QR. When you're ready, add your Razorpay keys in Config → Payments, turn the switch on, and set the webhook URL `https://yourdomain/api/payments/razorpay/webhook` in Razorpay.
- **Email OTP through Hostinger**: users can log in with a 6-digit email code, reset a forgotten password and verify their email. Admin can require a verified email before booking, KYC, joining groups and withdrawals. Set it up in Config → Email (Hostinger): server `smtp.hostinger.com`, port `465`, your mailbox and its password, then click **Send test email**. Without email set up, codes are printed in the server console (development only).
- **Email notifications** (sent through the same Hostinger mailbox) for new booking requests, accept and decline, tutor on the way and arrived, payments verified, withdrawals, homework, progress reports and help-ticket replies. Users can turn them off in Account.
- **Ratings after every class**: overall, punctuality and teaching, shown on the tutor's profile
- **Police verification and background check** set by staff on the KYC page. KYC approved + police verified + background clear = **🛡️ Verified** badge. A flagged tutor is hidden from search immediately.
- **Phone numbers hidden**: parents and tutors talk through **in-app chat**, which hides phone numbers and emails automatically and flags those messages for staff. Optional **masked calls** via Exotel, so both sides only see the Edvitta number.
- **Progress reports and homework**: tutors post topics, understanding level, strengths and areas to improve, and assign homework with due dates. Parents mark homework done and the tutor reviews it.
- **Trial / demo class**: tutors can offer one free or low-cost trial class. Each parent gets one trial per tutor.
- **In-app video classes** (WebRTC) for online bookings. Only the booking's parent and tutor can join, and join and leave times are logged. Meet or Zoom links still work too. For classes on strict office or school networks, add a TURN server in Config → Classes.
- **Subscription packages** such as 8, 12, 20 or 60 classes at a discount, managed in Admin → Packages
- **Languages**: English, हिन्दी, ಕನ್ನಡ and తెలుగు (switcher at the top). Menus, buttons, headings, form labels and subjects are translated. Some longer help sentences are still in English.
- **Tutor earnings dashboard**: this month and all-time fees, commission, GST and amount received, a month-by-month chart, **commission invoices for every class** (numbered `EDV/C/2026-27/00001`) and printable **monthly statements**. Parents get a **payment receipt** for every booking. Admin → Invoices shows total commission and GST.

### Added in version 3
- **Attendance**: every class shows attended, tutor absent, student absent or not marked. Tutors mark a class missed on the day; parents can report "tutor didn't come" 15 minutes after the start time.
- **Automatic rescheduling**: a class the tutor misses (or nobody marks by the next day) gets a **free make-up class** on the next free day of the plan. When a student is absent, Config → Classes decides: free make-up (default) or the class is counted and the tutor paid.
- **Holidays and leave**: parents mark "child on leave" for a future class, tutors plan leave days (limit per month in Config), and admin adds platform holidays (e.g. Diwali). Classes on those days move to the end of the plan and everyone is told.
- **Weekly payouts** (Admin → Payouts): each tutor's week (Monday to Sunday) with classes, fees, commission, GST, earnings, payout UPI and missed classes, plus a **CSV for bulk bank/UPI payouts**. "Settle this week" turns each tutor's earnings into payout requests to their saved UPI. Tutors see their weekly earnings and save their payout UPI in Earnings, and get a weekly summary every Monday. Automatic Monday settlement can be switched on in Config → Payouts.
- **Analytics** (Admin → Analytics): bookings and commission per day, booking funnel, trial-to-paid conversion, attendance rates, top areas (with "recruit tutors" hints where demand is high), top subjects and top tutors, for 7 days to 1 year.
- **WhatsApp alerts** (Meta WhatsApp Cloud API) are **OFF by default**. Turn them on in Config → WhatsApp after Meta approves your message template (`edvitta_alert`, body `Edvitta: {{1}}`). By default only important alerts go to WhatsApp (booking requests and answers, tutor on the way, class moved, payments, SOS). Users can switch WhatsApp off in Account.

### Security review (version 3)
- **2-step sign-in for admin and staff**: password, then a 6-digit code emailed to them (active once Hostinger email is set up; switch in Config → Login & security). Admin and staff can't log in with an email code alone.
- **Classes can only be started on their own day**, so nobody can "complete" future classes early to release the money.
- **Tutor home locations are protected**: search distances are worked out from a point blurred to about 500 m and shown in 0.5 km steps, and searches are rate-limited, so repeated searches can't pinpoint where a tutor lives.
- **Live connections** (tracking, chat, video) only accept this site's own pages, and they are cut off immediately when a user logs out everywhere, changes or resets their password, is suspended, or has staff permissions changed.
- **Payments**: Razorpay verification never runs with an empty key, and the webhook credits only the exact order amount in INR.
- **Reward money** (referral and welcome bonus from the last 90 days) can be used for classes but not withdrawn as cash.
- **Chat** also hides spelled-out numbers ("nine eight seven…") and outside links (Meet/Zoom/Teams class links stay), and flags requests to move to WhatsApp, Instagram or Telegram for staff.
- **Email codes**: at most 10 per email per day, 5 tries each. Password resets notify the user.
- **CSV exports** are protected against spreadsheet formula injection.
- In production the admin account never gets the default password: set `ADMIN_PASSWORD`, or a random one is printed once.
- The email library was upgraded to nodemailer 10 (`npm audit` reports 0 vulnerabilities).

---

## Security (built for an app used with children)

- **Tutor verification**: tutors are hidden from search until a person approves their KYC. Police verification is shown as a badge.
- **KYC files are private**: they are stored outside the public folder with random names and checked by their real file content (a fake ".png" is rejected). Only admin and staff with KYC permission can open them, and every view is written to the audit log.
- **Child privacy**: before a booking is confirmed, a tutor sees only the child's initial and class and the area name, never the phone number or exact address. Community groups hide children's names from non-members.
- **Location privacy**: the tutor's exact position never appears in search, only the distance. Live location is stored and sent **only while a home session is in progress**, and **only to that booking's parent** (plus admin and safety staff).
- **Start code for each visit**, plus SOS alerts to every admin and safety staff member in real time
- **Logins**: passwords are hashed with bcrypt (cost 12). Accounts lock for 15 minutes after 5 failed attempts, and login and signup are rate-limited. Sessions use httpOnly, SameSite=strict cookies (JavaScript can't read them). "Log out of all devices" is available, and suspending a user logs them out everywhere.
- **Web attacks**: CSRF protection, strict Content-Security-Policy and security headers (helmet), validation on every input, all output escaped against XSS, only `https://` class links accepted, file upload size limits, API rate limiting
- **Roles**: nobody can sign up as admin or staff. Staff permissions are checked on every API call.
- **Money**: amounts are stored in paise (no rounding errors), every wallet change is an atomic database transaction, a balance can never go negative, and there is a full ledger plus an audit log of admin actions

---

## Going live (production checklist)

1. **Hosting**: any Node host works (Render, Railway, a DigitalOcean or AWS VM). Copy `.env.example` to `.env` and set a long `JWT_SECRET`, your admin email and password, `NODE_ENV=production` and `TRUST_PROXY=1`. Put it behind **HTTPS**, which is required for GPS on phones.
2. **Payment gateway**: Razorpay is already built in and switched off. Turn it on in Config → Payments when your account is approved. Switch off "Demo top-up" before launch (it is blocked automatically in production).
3. **Email**: set up the Hostinger mailbox in Config, then turn on "Require verified email".
4. **Database**: SQLite is fine for launch and the first few thousand users. Back up the `data/` folder every day. For larger scale, move to PostgreSQL (with PostGIS for location search).
5. **KYC automation (optional)**: add DigiLocker or an Aadhaar/PAN verification API (Signzy, IDfy, Karza) so documents are checked automatically, and keep the human approval step.
6. **Play Store and App Store**: the web app already installs from the browser. To publish real store apps, wrap it with **Capacitor** (`npx cap add android` / `ios`) and use the background-location plugin, so tutors' tracking keeps working when the phone screen is off.
7. **Legal**: privacy policy, terms of use and a child safety policy, as required by the DPDP Act 2023 for children's data (verifiable parental consent).

## Project layout
```
server/
  index.js          app, security headers, live tracking (socket.io)
  db.js             database tables
  lib.js            login/roles, validation, wallet, coupons, distance
  uploads.js        secure file uploads
  seed.js           subjects, default settings, admin, demo data
  routes/           auth, tutor, bookings, money (wallet/ads/referrals), community, tickets, extras, ops (leave, payouts, analytics), admin
  schedule.js       attendance, holidays and automatic rescheduling
  whatsapp.js       WhatsApp alerts (off by default)
  jobs.js           daily and weekly background jobs
public/
  index.html, styles.css, sw.js, manifest
  js/               core, layout, common, parent, tutor, admin screens
test/smoke.js       end-to-end checks
```
