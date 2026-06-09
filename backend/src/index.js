require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { PrismaClient } = require('@prisma/client');
const rateLimit = require('express-rate-limit');
const { verifyTelegramInitData } = require('./auth');

const app = express();
const prisma = new PrismaClient();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors({
  origin: process.env.FRONTEND_URL || '*',
  credentials: true
}));
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));

// Rate limiting - basic per IP
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 200,
  message: 'Too many requests'
});
app.use(limiter);

// Auth middleware
const authenticateTelegram = async (req, res, next) => {
  const initData = req.headers['x-telegram-init-data'] || req.body.initData;
  const botToken = process.env.BOT_TOKEN;

  if (!initData) {
    return res.status(401).json({ error: 'No Telegram auth data' });
  }

  const result = verifyTelegramInitData(initData, botToken);
  if (!result.valid) {
    return res.status(401).json({ error: result.error });
  }

  // Auto-create or update user
  const tgUser = result.user;
  let user = await prisma.user.findUnique({
    where: { telegram_id: String(tgUser.id) }
  });

  if (!user) {
    user = await prisma.user.create({
      data: {
        telegram_id: String(tgUser.id),
        username: tgUser.username || null,
        first_name: tgUser.first_name || null,
        last_name: tgUser.last_name || null,
        photo_url: tgUser.photo_url || null,
        language_code: tgUser.language_code || 'en'
      }
    });
  } else {
    // Update if changed
    await prisma.user.update({
      where: { telegram_id: String(tgUser.id) },
      data: {
        username: tgUser.username || user.username,
        first_name: tgUser.first_name || user.first_name,
        last_name: tgUser.last_name || user.last_name,
        photo_url: tgUser.photo_url || user.photo_url,
        language_code: tgUser.language_code || user.language_code
      }
    });
  }

  req.user = user;
  req.telegramUser = tgUser;
  next();
};

// Admin middleware
const requireAdmin = (req, res, next) => {
  if (req.user.role !== 'ADMIN') {
    return res.status(403).json({ error: 'Admin access required' });
  }
  next();
};

// ==================== HEALTH ====================
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// ==================== AUTH ====================
app.post('/auth/verify', authenticateTelegram, (req, res) => {
  res.json({
    success: true,
    user: {
      telegram_id: req.user.telegram_id,
      username: req.user.username,
      first_name: req.user.first_name,
      xp: req.user.xp,
      level: req.user.level,
      streak_count: req.user.streak_count,
      role: req.user.role
    }
  });
});

// ==================== MATCHES ====================
app.get('/matches', authenticateTelegram, async (req, res) => {
  try {
    // Auto-update statuses (simple polling logic)
    const now = new Date();
    const thirtyMin = 30 * 60 * 1000;

    await prisma.match.updateMany({
      where: {
        status: 'SCHEDULED',
        start_time: { lte: new Date(now.getTime() + thirtyMin) }
      },
      data: { status: 'LOCKED' }
    });

    await prisma.match.updateMany({
      where: {
        status: 'LOCKED',
        start_time: { lte: now }
      },
      data: { status: 'LIVE' }
    });

    const matches = await prisma.match.findMany({
      orderBy: { start_time: 'asc' },
      include: {
        predictions: {
          where: { user_id: req.user.telegram_id },
          select: { predicted_home_score: true, predicted_away_score: true, predicted_winner: true, points_awarded: true }
        }
      }
    });

    // Add user prediction if exists
    const enriched = matches.map(m => ({
      ...m,
      user_prediction: m.predictions[0] || null,
      can_predict: m.status === 'SCHEDULED'
    }));

    res.json(enriched);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Failed to fetch matches' });
  }
});

app.post('/matches', authenticateTelegram, requireAdmin, async (req, res) => {
  const { home_team, away_team, start_time } = req.body;

  if (!home_team || !away_team || !start_time) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  try {
    const match = await prisma.match.create({
      data: {
        home_team,
        away_team,
        start_time: new Date(start_time),
        status: 'SCHEDULED'
      }
    });
    res.json(match);
  } catch (error) {
    res.status(500).json({ error: 'Failed to create match' });
  }
});

app.patch('/matches/:id', authenticateTelegram, requireAdmin, async (req, res) => {
  const { id } = req.params;
  const { status, home_score, away_score } = req.body;

  try {
    const match = await prisma.match.update({
      where: { id: parseInt(id) },
      data: {
        status: status || undefined,
        home_score: home_score !== undefined ? parseInt(home_score) : undefined,
        away_score: away_score !== undefined ? parseInt(away_score) : undefined
      }
    });

    // If finished, trigger scoring
    if (status === 'FINISHED' && home_score !== undefined && away_score !== undefined) {
      await calculateMatchScores(parseInt(id));
    }

    res.json(match);
  } catch (error) {
    res.status(500).json({ error: 'Failed to update match' });
  }
});

// ==================== PREDICTIONS ====================
app.post('/predictions', authenticateTelegram, async (req, res) => {
  const { match_id, predicted_home_score, predicted_away_score } = req.body;
  const userId = req.user.telegram_id;

  if (!match_id || predicted_home_score === undefined || predicted_away_score === undefined) {
    return res.status(400).json({ error: 'Missing fields' });
  }

  try {
    const match = await prisma.match.findUnique({ where: { id: parseInt(match_id) } });
    if (!match) return res.status(404).json({ error: 'Match not found' });
    if (match.status !== 'SCHEDULED') {
      return res.status(400).json({ error: 'Predictions locked' });
    }

    const predicted_winner = predicted_home_score > predicted_away_score ? 'HOME' :
                            predicted_home_score < predicted_away_score ? 'AWAY' : 'DRAW';

    const prediction = await prisma.prediction.upsert({
      where: { user_id_match_id: { user_id: userId, match_id: parseInt(match_id) } },
      update: {
        predicted_home_score: parseInt(predicted_home_score),
        predicted_away_score: parseInt(predicted_away_score),
        predicted_winner
      },
      create: {
        user_id: userId,
        match_id: parseInt(match_id),
        predicted_home_score: parseInt(predicted_home_score),
        predicted_away_score: parseInt(predicted_away_score),
        predicted_winner
      }
    });

    // Update streak
    const today = new Date().toISOString().split('T')[0];
    const lastDate = req.user.last_prediction_date ? new Date(req.user.last_prediction_date).toISOString().split('T')[0] : null;

    let newStreak = req.user.streak_count;
    if (lastDate === today) {
      // same day, no change
    } else if (lastDate && new Date(lastDate) >= new Date(today) - 86400000) {
      newStreak += 1;
    } else {
      newStreak = 1;
    }

    await prisma.user.update({
      where: { telegram_id: userId },
      data: {
        last_prediction_date: new Date(),
        streak_count: newStreak
      }
    });

    res.json({ success: true, prediction });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Failed to save prediction' });
  }
});

// ==================== SCORING ENGINE ====================
async function calculateMatchScores(matchId) {
  const match = await prisma.match.findUnique({ where: { id: matchId } });
  if (!match || match.status !== 'FINISHED' || match.home_score === null || match.away_score === null) {
    return;
  }

  const actualWinner = match.home_score > match.away_score ? 'HOME' :
                      match.home_score < match.away_score ? 'AWAY' : 'DRAW';

  const actualDiff = Math.abs(match.home_score - match.away_score);

  // Determine multiplier
  let multiplier = 1.0;
  // Simple logic - assume group unless final (for MVP, can enhance later)
  // For now, use 1.0 for all, or detect by team names if needed
  if (match.home_team.includes('Final') || match.away_team.includes('Final')) multiplier = 1.5;
  else if (match.home_team.includes('Semi') || match.away_team.includes('Semi')) multiplier = 1.2;

  const predictions = await prisma.prediction.findMany({ where: { match_id: matchId } });

  for (const pred of predictions) {
    let points = 0;

    // Winner / Draw
    if (pred.predicted_winner === actualWinner) {
      points += 3;
    }

    // Exact score
    if (pred.predicted_home_score === match.home_score && pred.predicted_away_score === match.away_score) {
      points += 5;
    } else {
      // Goal difference
      const predDiff = Math.abs(pred.predicted_home_score - pred.predicted_away_score);
      if (predDiff === actualDiff) {
        points += 2;
      }
    }

    points = Math.floor(points * multiplier);

    // Streak bonus
    const user = await prisma.user.findUnique({ where: { telegram_id: pred.user_id } });
    if (user) {
      if (user.streak_count >= 5) points += 5;
      else if (user.streak_count >= 3) points += 2;
    }

    // Update prediction and user XP
    await prisma.prediction.update({
      where: { id: pred.id },
      data: { points_awarded: points }
    });

    await prisma.user.update({
      where: { telegram_id: pred.user_id },
      data: {
        xp: { increment: points },
        level: { set: Math.floor((user.xp + points) / 100) + 1 }
      }
    });
  }
}

// Manual trigger for scoring (admin)
app.post('/admin/calculate-scores/:matchId', authenticateTelegram, requireAdmin, async (req, res) => {
  const { matchId } = req.params;
  try {
    await calculateMatchScores(parseInt(matchId));
    res.json({ success: true, message: 'Scoring recalculated' });
  } catch (error) {
    res.status(500).json({ error: 'Scoring failed' });
  }
});

// ==================== LEADERBOARDS ====================
app.get('/leaderboard/global', authenticateTelegram, async (req, res) => {
  try {
    const users = await prisma.user.findMany({
      orderBy: [{ xp: 'desc' }, { streak_count: 'desc' }],
      take: 100,
      select: {
        telegram_id: true,
        username: true,
        first_name: true,
        xp: true,
        level: true,
        streak_count: true
      }
    });

    const leaderboard = users.map((u, index) => ({
      rank: index + 1,
      display_name: u.username ? `@${u.username}` : u.first_name || `Player #${u.telegram_id.slice(-4)}`,
      ...u
    }));

    res.json(leaderboard);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch leaderboard' });
  }
});

app.get('/leaderboard/league/:leagueId', authenticateTelegram, async (req, res) => {
  const { leagueId } = req.params;
  try {
    const members = await prisma.leagueMember.findMany({
      where: { league_id: parseInt(leagueId) },
      include: {
        user: {
          select: {
            telegram_id: true,
            username: true,
            first_name: true,
            xp: true,
            level: true,
            streak_count: true
          }
        }
      }
    });

    const leaderboard = members
      .map(m => m.user)
      .sort((a, b) => b.xp - a.xp)
      .map((u, index) => ({
        rank: index + 1,
        display_name: u.username ? `@${u.username}` : u.first_name || `Player #${u.telegram_id.slice(-4)}`,
        ...u
      }));

    res.json(leaderboard);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch league leaderboard' });
  }
});

// ==================== LEAGUES ====================
app.post('/leagues', authenticateTelegram, async (req, res) => {
  const { name } = req.body;
  if (!name) return res.status(400).json({ error: 'League name required' });

  try {
    const invite_code = Math.random().toString(36).substring(2, 10).toUpperCase();

    const league = await prisma.league.create({
      data: {
        name,
        owner_id: req.user.telegram_id,
        invite_code
      }
    });

    // Add owner as admin
    await prisma.leagueMember.create({
      data: {
        league_id: league.id,
        user_id: req.user.telegram_id,
        role: 'ADMIN'
      }
    });

    res.json(league);
  } catch (error) {
    res.status(500).json({ error: 'Failed to create league' });
  }
});

app.post('/leagues/join', authenticateTelegram, async (req, res) => {
  const { invite_code } = req.body;
  if (!invite_code) return res.status(400).json({ error: 'Invite code required' });

  try {
    const league = await prisma.league.findUnique({ where: { invite_code } });
    if (!league) return res.status(404).json({ error: 'Invalid invite code' });

    const existing = await prisma.leagueMember.findUnique({
      where: { league_id_user_id: { league_id: league.id, user_id: req.user.telegram_id } }
    });
    if (existing) return res.status(400).json({ error: 'Already a member' });

    await prisma.leagueMember.create({
      data: {
        league_id: league.id,
        user_id: req.user.telegram_id,
        role: 'MEMBER'
      }
    });

    res.json({ success: true, league });
  } catch (error) {
    res.status(500).json({ error: 'Failed to join league' });
  }
});

app.get('/leagues/my', authenticateTelegram, async (req, res) => {
  try {
    const memberships = await prisma.leagueMember.findMany({
      where: { user_id: req.user.telegram_id },
      include: {
        league: {
          include: {
            _count: { select: { members: true } }
          }
        }
      }
    });

    res.json(memberships.map(m => ({
      ...m.league,
      role: m.role,
      member_count: m.league._count.members
    })));
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch leagues' });
  }
});

// ==================== ADMIN PANEL ====================
app.get('/admin/matches', authenticateTelegram, requireAdmin, async (req, res) => {
  const matches = await prisma.match.findMany({ orderBy: { start_time: 'desc' } });
  res.json(matches);
});

app.get('/admin/users', authenticateTelegram, requireAdmin, async (req, res) => {
  const users = await prisma.user.findMany({
    orderBy: { xp: 'desc' },
    take: 50
  });
  res.json(users);
});

// Simple analytics
app.get('/admin/analytics', authenticateTelegram, requireAdmin, async (req, res) => {
  const totalUsers = await prisma.user.count();
  const totalPredictions = await prisma.prediction.count();
  const totalMatches = await prisma.match.count();
  const activeUsers = await prisma.user.count({
    where: { updated_at: { gte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) } }
  });

  res.json({
    total_users: totalUsers,
    total_predictions: totalPredictions,
    total_matches: totalMatches,
    active_users_7d: activeUsers
  });
});

// ==================== USER PROFILE ====================
app.get('/profile', authenticateTelegram, async (req, res) => {
  const user = await prisma.user.findUnique({
    where: { telegram_id: req.user.telegram_id },
    include: {
      predictions: {
        include: { match: true },
        orderBy: { created_at: 'desc' },
        take: 10
      }
    }
  });
  res.json(user);
});

// ==================== STATIC AI INSIGHTS (Template-based) ====================
app.get('/insights/:matchId', authenticateTelegram, async (req, res) => {
  const { matchId } = req.params;
  const match = await prisma.match.findUnique({ where: { id: parseInt(matchId) } });
  if (!match) return res.status(404).json({ error: 'Match not found' });

  // Static template-based insights (NO LLM)
  const insights = [
    `${match.home_team} has strong recent form.`,
    `${match.away_team} struggles away from home.`,
    `Expect a tight match between these two sides.`,
    `Key players are in good shape for both teams.`,
    `Historical head-to-head favors ${Math.random() > 0.5 ? match.home_team : match.away_team}.`
  ];

  res.json({
    match: `${match.home_team} vs ${match.away_team}`,
    preview: insights[Math.floor(Math.random() * insights.length)]
  });
});

// Start server
app.listen(PORT, () => {
  console.log(`🚀 PREDICTCUP 2026 Backend running on port ${PORT}`);
  console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
});
