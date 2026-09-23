# Price Alerts - Setup

How it works: cron-job.org calls `/api/alert-check` every minute. When a new 5-minute price is out,
that function reads it from ComEd and checks it against each device's own alert price (set in the app,
default 20¢ = the red tier). A device gets "Prices are high" when the price goes above its alert price and
"Prices are back down" after two prices in a row at or under it. Devices are stored in Supabase.

## 1. Supabase (database)

1. Create a free project at https://supabase.com.
2. Open **SQL Editor**, paste all of `supabase/schema.sql`, and click **Run**.
3. Open **Project Settings** and copy:
   - **Project URL** (`https://xxxx.supabase.co`, under Data API / API) -> `SUPABASE_URL`
   - A **secret** key (under API Keys: a `sb_secret_...` key, or the legacy **service_role** key) ->
     `SUPABASE_SERVICE_ROLE_KEY`. Never the publishable/anon key. Either style works.

## 2. Keys

In Terminal, from this folder:

```bash
sh scripts/generate-keys.sh
```

This prints `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY` and `ALERT_CHECK_SECRET`. Keep them private.
Generate them once - changing the VAPID keys later means every device has to turn alerts on again.

## 3. Vercel environment variables

Vercel -> your project -> **Settings -> Environment Variables**. Add each for **Production**:

| Name | Value |
| --- | --- |
| `SUPABASE_URL` | from step 1 |
| `SUPABASE_SERVICE_ROLE_KEY` | from step 1 |
| `VAPID_PUBLIC_KEY` | from step 2 |
| `VAPID_PRIVATE_KEY` | from step 2 |
| `VAPID_SUBJECT` | `mailto:` + an email you check, e.g. `mailto:you@example.com` |
| `ALERT_CHECK_SECRET` | from step 2 |

Also check **Settings -> General -> Framework Preset** is **Other** (not Express).
Then deploy (env vars only apply to new deployments).

## 4. Check the deploy

- `https://live-comed.vercel.app/sw.js` should show JavaScript, not the page's HTML.
- `https://live-comed.vercel.app/api/config` should show `{"vapidPublicKey":"B...","pushConfigured":true}`.

## 5. cron-job.org (scheduler)

1. Sign up at https://cron-job.org and click **Create cronjob**.
2. URL: `https://live-comed.vercel.app/api/alert-check`
3. Schedule: **Every minute**. (The function only calls ComEd when a new price is due, so this is cheap.)
4. **Advanced -> Headers**: add `x-alert-secret` = your `ALERT_CHECK_SECRET`.
5. Save, then **Test run**. A good response looks like `{"ok":true,"result":"normal",...}` or `"not-due"`.
   `401` = the header/secret doesn't match. `500` = check Vercel -> Logs for the missing variable.

## 6. Turn alerts on

- **iPhone (iOS 16.4+):** open the site in Safari -> Share -> **Add to Home Screen**, open Voltra from the
  Home Screen, then flip **Price Alerts** on and allow notifications. (iPhone doesn't allow web push
  from a normal Safari tab.)
- **Android / desktop Chrome, Edge, Firefox:** flip the switch and allow notifications.

## 7. Test it

1. **Delivery:** with alerts on, tap **Send test**. A "Voltra test alert" should arrive within seconds.
   This checks Supabase, the keys and the phone's notification settings - but not the scheduler.
2. **The real alert path:** set **Alert me above** to something *below* the current live price
   (e.g. `1`). Within about 5 minutes (the next price) you should get "Prices are high".
   This checks cron-job.org and `/api/alert-check` too.
3. Set it back to `20` (or whatever you like). Changing the alert price resets that device quietly -
   no all-clear is sent for the test.
