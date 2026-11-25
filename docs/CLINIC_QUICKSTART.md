# Mission Minded — quick start for a clinic day (app 0.0.24)

The one page to hand whoever sets the laptops up. The details are in
[CLOUD_SETUP.md](CLOUD_SETUP.md).

## 1. Which version is this?
There are two version numbers, and they are **separate**:

| What | Looks like | Where you see it |
|---|---|---|
| **The app** on each laptop | `0.0.24` | Bottom of the sidebar: **App 0.0.24** |
| **The sync server** (internet or clinic network) | `1.9.0` | Admin → Cloud says when it needs updating |

So "0.0.22" and "1.7"/"1.8"/"1.9" are not two versions of the same thing: the first
is an app, the second a server. What matters is that **every laptop runs the same
app version** — check the sidebar on each before the clinic opens.

## 2. Updating
- When a new version is out, a blue banner at the top of every screen says so:
  **A new version of Mission Minded is ready** → **Update now** → **Download**.
- When it has downloaded, the banner says **Restart & install** (an administrator
  presses it). The records stay as they are.
- On a Mac, download the new version from the releases page and drag it to
  Applications, replacing the old copy.
- With no internet: put the installer on a USB stick, press the **App 0.0.24** button
  (top right, or the bottom of the sidebar) and use **From USB / folder**.
- After the app is updated, Admin → Cloud may offer **Update the sync server** —
  do that too (internet server only; it needs a Cloudflare token, as at setup).

## 3. Connecting the laptops
**With internet (the internet server).** Set it up once (Admin → Cloud → Internet
server → *Set up the sync server*). On every other laptop paste the **connection
code** (Admin → Cloud → Show connection code on a connected laptop).

**No internet (the clinic network).** Any Wi-Fi router, no internet needed.
1. On the laptop that stays on all day: Admin → Cloud → **Clinic network (no
   internet)** → **Host the clinic network**. Its card shows the **clinic key** in
   large numbers, like **482-913**.
2. On each other laptop, on the same Wi-Fi: Admin → Cloud → Clinic network →
   **Choose** the clinic → type the clinic key → **Join**. (Spaces and dashes do not
   matter.)
3. **How do I know a laptop is in?** The sidebar says **Clinic network: connected —
   Synced … min ago**, and its Cloud tab says **"You're in"**. The host lists it under
   *Laptops connected now*.
4. **Not joining?** It is almost always the Wi-Fi: every laptop on the router's own
   network (not a guest network or a phone hotspot), the router's *AP / client
   isolation* **off**, and on the host Windows set to a **Private network** with the
   app allowed through the firewall. **Test the clinic network** says which.
5. The host can **Change the clinic key**; laptops already joined stay joined. If a
   laptop is lost, tick *Also make every other laptop join again*.

Every laptop must run **0.0.24 or later** to join with the short key (or paste the
connection code). A host whose key was chosen by hand in 0.0.23 keeps that key as its
clinic key, and the laptops already joined stay joined. Its card then offers **Make a new
password**: press it once every laptop runs 0.0.24 — they join again once, typing the
same clinic key.

## 4. Pre-registration (internet server only)
- Admin → **Events** → **Pre-reg link**: copy the link, or let patients scan the **QR
  code**; **Print a sign with the QR code** prints a door sign in English and Spanish.
  A new event shows its link and QR code as soon as it is created.
- **Time slots** (Edit event → *Pre-registration time slots*): patients choose the hour
  they will arrive, and each hour takes at most so many (for example 8 an hour,
  8:00 to 12:00). Arrivals shows each patient's time, in that order. Walk-ins are not
  counted.
- The link does not work on the clinic network, which has no internet.

## 5. Wristbands
Admin → **Events** → **Wristband labels on this laptop**: choose the band or label the
printer holds (1 × 11 in band, 2 × 1 in label, … or a size in mm) and the printer
(203 dpi for most wristband printers). **Print a test band** and scan it. Set the
printer itself to the same label size and to 100% (no "fit to page"). The barcode
holds only the patient's **six-digit wristband number** printed beside it (Code 128 —
not a UPC), never the name or date of birth.

## 6. At Dental Triage
- **Add filling / Add extraction** for each tooth, and mark each **This visit** or
  **Future visit**. A future one is kept for the patient's next clinic, where the
  chart shows it under *Still to do from an earlier visit*.
- **Move Patient to Treatment Waiting** needs this visit's treatment chosen. The
  *Treatment waiting* list is in the order patients were moved there, says what each
  needs (Filling / Extraction), and filters to only fillings or only extractions.

## 7. The exit survey is anonymous
The answers are never saved with the patient's name or record — each laptop only adds
them to its running totals for the clinic, which the reports add up. The survey says so
to the patient, in English and Spanish. A survey answered that way cannot be reopened.
Update **every** laptop: one still on an older version would show such a survey as
answered with no answers, and let it be taken again.

## 8. One account per person
Signing in with an account that is in use on another laptop shows a warning. Give each
volunteer their own account (Admin → Staff & roles), so the record says who did what.

## 9. Tablets and iPads
Mission Minded is a **desktop app**: it runs on **Windows** and **Mac** laptops, and on
**Windows tablets** (a Surface, for example), which can be used as the check-in kiosk.
It **cannot be installed on an iPad, iPhone or Android tablet** — Apple and Google only
allow their own app stores' apps there, and the app keeps the clinic's records in a
database on the laptop itself. What an iPad *can* do, with internet: open the online
**pre-registration link** in Safari, so patients fill the form in at the door. There is
no offline iPad check-in.
