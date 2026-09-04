# Mission Minded Worldwide — Free Clinic Patient Records

An **offline-first** desktop application for Mission Minded Worldwide's free
dental, medical and vision clinics. It replaces the bilingual paper packet — the
Patient Record and the Patient Application and Consent for Health Care — with a
single digital workflow: registration, medical clearance, x-ray triage, dental
treatment, check-out and reporting.

Built as a Windows desktop app (Electron). **All patient data lives on the
device.** There is no built-in server: the app ships with sync switched off and
nothing configured, and records leave the machine only when an authorized staff
member exports them, or when an administrator deliberately connects the clinic
to a sync server it deploys and controls itself.

> ### ⚠️ Early preview — v0.0.3
>
> **v0.0.3 severs an inherited cloud connection.** Builds up to and including
> v0.0.2 shipped a hard-coded sync server and key belonging to the organisation
> this app was forked from, and connected to it automatically at startup. Those
> installs exchanged records with another clinic's database. v0.0.3 removes the
> built-in server entirely, refuses that endpoint outright, and on first launch
> erases any records an affected machine is holding, returning it to first-run
> setup. **Do not keep using a v0.0.1 or v0.0.2 build.**
> This is the first cut. The application is carried over from the Mission Minded
> codebase and rebranded to MMW, with the MMW flow (wristband IDs, the four
> Clearance vitals, service selection) built on top. **It has not been used in a
> live clinic, and the consent wording has not been through legal review.** Treat
> it as a preview to try and give feedback on, not as a system of record.

---

## The clinic flow

The app follows the MMW EMR flow, and each station starts by scanning the
patient's wristband rather than searching for a name:

| Step | Station | What happens |
|---|---|---|
| 1 | **Registration** | Demographics, services needed (dental / medical / vision), signed waiver. Issues a **6-digit patient ID** and prints a **Code 128 wristband**. |
| 2 | **Medical Clearance** | Scan the band. Blood pressure, blood sugar, pulse, respiration; allergies, medications, medical history. Routes to cleaning or x-ray. |
| 3 | **X-ray / Triage** | Scan the band. Number of films, and what is needed — cleaning, extraction, root canal, filling, referral. |
| 4 | **Dental Treatment** | Odontogram, fillings by surface, extractions (simple / surgical), cleaning, anaesthetic, signed treatment note. |
| 5 | **Check-out** | Visit summary, record export, and the patient leaves. |

Reporting keeps **de-identified event totals** that survive a patient-data
purge, so a clinic can answer a grant return after the records are gone.

---

## ⬇️ Download the Windows app

Every push to `main` builds a fresh Windows `.exe` on GitHub's Windows runners
and publishes it on the **[Releases](../../releases)** page:

- **`MMW-Setup-0.0.3.exe`** — standard installer (Start-menu + desktop
  shortcuts, and required for auto-update).
- **`MMW-Portable-0.0.3.exe`** — single portable executable that runs without
  installing (ideal for a USB stick on shared clinic laptops).

The same files are on any successful run under **Actions → Build Windows App →
Artifacts**.

Windows will warn that the publisher is unknown — the build is not code-signed.
Choose **More info → Run anyway**.

### First run — setting up a computer

There are **no default accounts**. The first time the app opens on a machine it
shows a setup screen with two ways through:

**Set up this computer** — you are the first person. Enter your name, choose a
username and password (8+ characters), and optionally name the clinic. That
creates the clinic's administrator and signs you straight in. Add the rest of
your team under **Admin → Staff & roles**.

**Join a clinic already set up** — the clinic already exists on another laptop.
Enter the clinic address and key from **Admin → Cloud** on the first machine.
This computer downloads the clinic, including its staff accounts, and everyone
signs in with the account they already have.

> There is no password recovery. Write the administrator password down and keep
> it somewhere safe — if it is lost, the only way back in is a fresh install,
> which starts with an empty database.

---

## Feature coverage (Phase 1 / v1.0)

Mirrors the six modules of the product map:

1. **Patient Check-In & Intake** — bilingual (English / Spanish) kiosk wizard,
   full demographics, 28-condition medical history, dental history, digital
   **consent with signature capture**, conditional oral-surgery consent, and
   **read-aloud** of every consent section in the patient's language.
2. **Triage** — live patient queue, **auto-flagged medical conditions**,
   consent-status indicator, triage checklist (cleaning / extraction / filling /
   no treatment / referral), interactive **tooth charts** (Universal adult 1–32
   and primary A–T), x-ray upload, and routing to a provider.
3. **Provider / Clinical View** — fillings (tooth # + surface + position),
   extractions (simple → surgical → root tip), cleaning options, **anesthetic
   log** (Lidocaine, Articaine, …), clinical notes, and a provider **sign-off
   that locks the record**.
4. **Reporting & Export** — **PDF Progress Note** and **full-packet PDF** that
   match the CHW form, on-screen preview, print to a local wireless printer,
   "screen display" mode for the patient to photograph, and email hand-off.
5. **Admin & Settings** — roles (Admin / Doctor / Triage), staff management,
   **event creation & patient grouping**, language-pack overview, backup, and an
   **audit log**.
6. **Data & Connectivity** — embedded **SQLite** database, USB / drive backup
   (single-file `.db`), JSON event export, returning-patient lookup across
   events. No core function makes a network call.

---

## Design principles

- **Offline-first** — every core feature works with no internet at all.
- **Language-agnostic** — language is chosen at the first intake screen; English
  and Spanish ship built-in, more packs add per deployment.
- **Low-friction intake** — large touch targets, minimal scrolling, a guided
  step-by-step wizard a patient can finish in a few minutes.
- **Clinical simplicity** — provider screens mirror the paper Progress Note
  (checklists, not complex data entry).
- **Data sovereignty** — no third-party servers; unless this clinic connects
  a sync server of its own, data stays on the
  device.

---

## Run from source (developers)

```bash
npm install
npm start          # launch the app in development
npm run icon       # regenerate brand icons from assets/icon.svg (needs sharp)
npm run dist       # build the Windows installer + portable exe into release/
```

> `npm run dist` produces Windows binaries and is intended to run on Windows (or
> via the included GitHub Actions workflow, which builds on `windows-latest`).

### Project layout

```
assets/                 Brand icon (svg/png/ico) and header logo
src/main/               Electron main process
  main.js               Window + lifecycle
  preload.js            Secure context-bridge IPC API
  db.js                 SQLite schema, repositories, auth (scrypt)
  ipc.js                IPC handlers + role-based access control
  pdf.js                Progress Note / full-packet PDF rendering
src/renderer/           UI (vanilla ES modules, no bundler)
  index.html
  styles/               Design system (theme + components)
  i18n/strings.js       Bilingual catalogue + medical condition lists
  js/                   App shell, router, views, components
.github/workflows/      Windows build → release
```

---

## Security & data handling

- Patient data is stored in a local SQLite database under the OS user-data
  directory; it never leaves the machine unless a staff member exports or backs
  it up.
- Staff passwords are hashed with scrypt and a per-user salt.
- Access is enforced per role at the IPC layer, matching the product-map
  permission matrix.
- The renderer runs with context isolation, no Node integration, and a strict
  Content-Security-Policy.

_Confidential — Mission Minded Worldwide © 2026._
