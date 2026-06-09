# 🏆 PREDICTCUP 2026

**Production-ready Telegram Mini App** for World Cup 2026 predictions.

Fully free-tier deployable • Simple • Secure Telegram auth • Real scoring • Leagues & Leaderboards

## 🚀 Quick Deploy (Free)

### 1. Backend (Render)

1. Fork this repo
2. Go to [Render.com](https://render.com) → New Web Service
3. Connect GitHub repo → Select `backend` folder as root
4. Use the `render.yaml` (or manual)
5. Add environment variables:
   - `BOT_TOKEN`: Your Telegram bot token (create via @BotFather)
   - `DATABASE_URL`: Will be auto from Render Postgres
6. Deploy

### 2. Database

- Render will create free PostgreSQL automatically via render.yaml
- Or manually: Neon / Render Postgres free tier

### 3. Frontend (Vercel - Recommended)

1. Go to [Vercel.com](https://vercel.com) → New Project
2. Import repo → Select `frontend` folder
3. Deploy (instant)
4. Update `API_BASE` in `frontend/index.html` to your Render backend URL

### 4. Telegram Mini App Setup

1. Create bot with @BotFather
2. Set Web App URL to your Vercel frontend URL
3. Users open via bot or direct link

## 🛠 Local Development

```bash
# Backend
cd backend
npm install
npx prisma migrate dev
npm run dev

# Frontend (simple static server)
cd frontend
python -m http.server 8000
```

## 🔐 Telegram Auth

Fully implemented with HMAC-SHA256 verification + 24h expiry.

## 📊 Features Implemented (MVP Complete)

✅ Telegram Mini App auth (secure)
✅ User auto-registration
✅ Matches with full lifecycle (SCHEDULED → LOCKED → LIVE → FINISHED)
✅ Winner + Exact score predictions
✅ Server-side scoring engine (+3/+5 + multipliers + streak bonuses)
✅ Leagues with invite codes
✅ Global + League leaderboards
✅ XP / Levels / Streaks
✅ Admin panel (create matches, set results, recalculate scores, analytics)
✅ i18n: English, Arabic (RTL), Kurdish Sorani (RTL)
✅ Design system with exact colors
✅ PWA support
✅ Static AI insights (no LLM)
✅ Docker + GitHub Actions + Render config

## 🎨 Design

Only #00539C, #FFD662, #F2B759 used.

## 📦 Tech Stack

- Backend: Node.js + Express + Prisma + PostgreSQL
- Frontend: Vanilla HTML5 + Tailwind CDN + Telegram WebApp
- No heavy frameworks

## ⚠️ Notes

- Matches created by admins (no external API needed)
- Status auto-updates on fetch (polling)
- No Redis, in-memory only

Built following the MASTER AI BUILD PROMPT strictly.

---

**Ready for production on free tiers.**
