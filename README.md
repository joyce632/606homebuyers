# 606 Home Buyers — Dispositions site

The public deal site for 606 Home Buyers, an Illinois real estate wholesaler. Buyers browse off-market deals with photos, price, ARV, repairs, beds and baths. The team signs in at `/team` to post deals, upload photos, change status (Active, Pending, Sold, Closed) and manage users.

- **Public site:** home page with hero and live inventory counts, deal grid with filters and search, and a shareable page for every deal (`/deal/<id>`) that shows a photo preview when the link is texted or emailed.
- **Team dashboard (`/team`):** deals table with inline status changes, deal editor with photo upload (JPG, PNG, WebP, iPhone HEIC), team-only fields (contract price, seller, access, notes) and assignment fee, "Copy for buyer blast", users, contact settings, and password change.
- **Roles:** *Admin* manages deals, users and site settings. *Editor* manages deals.

## Run it on your computer

```bash
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
ADMIN_EMAIL=you@example.com .venv/bin/python app.py
```

Open http://127.0.0.1:5060 (use this address, not "localhost"). On first run the app creates one admin account for `ADMIN_EMAIL` and saves a temporary password to `data/FIRST_LOGIN.txt`. Sign in at `/team`, set your own password, then delete that file.

## Deploy on Render

The repo includes a `render.yaml`, so Render sets up the web service, the Postgres database and the photo disk for you. The cost is the smallest paid web service, a 5 GB disk and the smallest paid Postgres (check Render's pricing page for current numbers).

1. Push this folder to a **private** GitHub repository.
2. On [render.com](https://render.com), go to **New → Blueprint** and pick the repo.
3. When Render asks for `ADMIN_EMAIL`, enter the email you'll sign in with. Click **Apply**.
4. When the deploy finishes, open the service's **Shell** tab and run `cat /var/data/FIRST_LOGIN.txt` to get the temporary password.
   - Sign in at `https://<your-app>.onrender.com/team` and set your own password.
   - Delete the file with `rm /var/data/FIRST_LOGIN.txt`.
5. In the dashboard, open **Site settings** and add the phone number and email buyers should use. Add a buyers-list sign-up link if you have one.
6. Optional: to use your own domain (for example `deals.606homebuyers.com`), go to **Settings → Custom Domains** in Render and add the CNAME record it shows at your domain provider. Render issues the HTTPS certificate.

What lives where:
- **Deals, users and settings:** Render Postgres (`DATABASE_URL`), with backups.
- **Photos:** the persistent disk at `/var/data/uploads`. Photos are resized to 2000 px, location data is stripped, and an 800 px thumbnail is made for the cards.
- **Updates:** push to GitHub and Render redeploys. Tables are created on startup.
- Without `DATABASE_URL` (on your computer) the app uses a SQLite file in `data/`.

## Adding a teammate

1. Sign in, open **Users**, enter their name and email, and pick a role.
2. Copy the temporary password shown and send it to them privately with the link to `/team`.
3. They set their own password the first time they sign in.

Use **Reset password** if someone gets locked out, or **Disable** to remove their access without deleting the account.
