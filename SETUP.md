# Arizona EDM Calendar — Setup Guide
## Get your live URL in ~30 minutes

---

## What you need before starting
- Your GitHub account (you have this)
- Your domain name ready
- 30 minutes

---

## STEP 1 — Get a free Ticketmaster API key (5 min)

1. Go to **developer.ticketmaster.com**
2. Click **Get Your API Key** → sign up for a free account
3. Create a new app (name it anything, e.g. "AZ EDM Calendar")
4. Copy your **Consumer Key** — this is your `TM_API_KEY`

> Free tier allows 5,000 calls/day — more than enough for weekly updates.

---

## STEP 2 — Upload this project to GitHub (5 min)

1. Go to **github.com** → click **New repository**
2. Name it `az-edm-calendar` → set to **Private** → click Create
3. On your computer, open Terminal (Mac) or Command Prompt (Windows)
4. Run these commands:

```bash
cd az-edm-calendar        # navigate into the folder you downloaded
git init
git add .
git commit -m "initial commit"
git branch -M main
git remote add origin https://github.com/YOUR_USERNAME/az-edm-calendar.git
git push -u origin main
```

> Replace `YOUR_USERNAME` with your GitHub username.

---

## STEP 3 — Connect to Netlify (5 min)

1. Go to **netlify.com** → sign up / log in with GitHub
2. Click **Add new site** → **Import an existing project** → **GitHub**
3. Select your `az-edm-calendar` repo
4. Netlify will detect `netlify.toml` automatically
5. Click **Deploy site**

> Your site will be live at a random URL like `random-name-123.netlify.app` for now.

---

## STEP 4 — Connect your custom domain (5 min)

1. In Netlify, go to **Site settings** → **Domain management** → **Add custom domain**
2. Enter your domain name → click **Verify**
3. Netlify will show you DNS records to add
4. Log into your domain registrar (GoDaddy, Namecheap, etc.)
5. Add the DNS records Netlify gives you
6. Wait 5–30 minutes for DNS to propagate
7. Netlify auto-provisions a free SSL certificate

---

## STEP 5 — Add your API keys as GitHub Secrets (5 min)

Your API keys must never be stored in code. GitHub Secrets keeps them secure.

1. In your GitHub repo → go to **Settings** → **Secrets and variables** → **Actions**
2. Click **New repository secret** and add each of these:

### Secret 1: Ticketmaster API Key
- Name: `TM_API_KEY`
- Value: your Consumer Key from Step 1

### Secret 2: Netlify Auth Token
- Go to **netlify.com** → click your avatar → **User settings** → **Applications**
- Click **New access token** → name it `github-actions` → copy it
- Name: `NETLIFY_AUTH_TOKEN`
- Value: the token you just copied

### Secret 3: Netlify Site ID
- In Netlify → **Site settings** → **General** → copy the **Site ID**
- Name: `NETLIFY_SITE_ID`
- Value: the Site ID

---

## STEP 6 — Run your first update (2 min)

1. In your GitHub repo → go to **Actions** tab
2. Click **Weekly EDM Calendar Update** in the left sidebar
3. Click **Run workflow** → **Run workflow**
4. Watch it run — takes about 2 minutes
5. Visit your domain — it's live with fresh data!

---

## How it works after setup

Every **Monday at 8 AM** GitHub automatically:
1. Pulls latest EDM events from Ticketmaster API for Phoenix + Tucson
2. Merges with your curated festival lineups
3. Rebuilds the HTML file
4. Deploys to Netlify → your URL updates instantly

Your teammates just bookmark the URL — it's always current.

---

## Adding new shows manually

To add a show that Ticketmaster doesn't have:
1. Open `build.js` in GitHub (click the file → pencil icon to edit)
2. Find the `CURATED` array near the top
3. Add a new event object following the same format
4. Click **Commit changes** — GitHub Actions will auto-deploy

---

## Troubleshooting

**Build fails with "TM_API_KEY not set"** → Check Step 5, make sure the secret name is exactly `TM_API_KEY`

**Site shows old data** → Go to GitHub Actions → run the workflow manually

**Domain not working** → DNS can take up to 24 hours. Check Netlify's domain dashboard for status.

**No events showing** → Ticketmaster's EDM filter may need adjustment. Contact me to tweak the keyword list in `build.js`.

---

## Need help?

Send your teammate (or me) a message — this whole system runs for $0/month.
