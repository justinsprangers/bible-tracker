# Bible Tracker

An offline-first app for logging Bible reading chapter by chapter. Install it on your phone or computer. It can optionally sync between your devices through a Google Sheet that you own.

**Open the app:** the GitHub Pages address of this repo (Settings → Pages).

## Use it on one device
Open the app and start tapping chapters. That's it. Everything is saved on the device and works offline. To install it:
- **iPhone (Safari):** Share → **Add to Home Screen**. Use it from the icon, because the home-screen app keeps its own storage.
- **Android (Chrome):** ⋮ → **Install app**
- **Computer (Chrome/Edge):** the install icon in the address bar

## Sync between your devices (optional, about 10 minutes)
1. Create a blank Google Sheet, then choose **Extensions → Apps Script**. Replace the starter code with [apps-script/Code.gs](apps-script/Code.gs).
2. Change `const TOKEN = 'CHANGE-ME';` to a long random string, then click **Save**.
3. Click **Deploy → New deployment → Web app**. Set Execute as **Me** and Who has access **Anyone**. Click **Deploy** and authorize it. On Google's "unverified app" warning, choose **Advanced → Go to …** (it's your own script).
4. Copy the Web app URL (it ends in `/exec`).
5. In the app, go to **Settings → Sync across devices**, paste in the URL and your token, then tap **Save & sync**. Do this on each device.

Your data lives only in your own sheet. Sync runs on its own: when the app opens, after each change, and every 2 minutes while it's open. The first device to connect to an empty sheet uploads what it already has.
