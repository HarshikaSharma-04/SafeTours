const jwt = require('jsonwebtoken');
const User = require('../models/User');
const RefreshToken = require('../models/RefreshToken');
const ApiError = require('../utils/apiError');
const ApiResponse = require('../utils/apiResponse');
const asyncHandler = require('../utils/asyncHandler');
const { generateAccessToken, generateRefreshToken } = require('../utils/token');
const passwordResetService = require('../services/passwordResetService');

// ─── Cookie options ───────────────────────────────────────────────────────────
const cookieOptions = {
  httpOnly: true,
  secure: process.env.NODE_ENV === 'production',
  sameSite: 'strict',
};

// ─── Helper: parse a JWT expiry string ("7d", "15m") into milliseconds ────────
const parseExpiry = (expiry = '7d') => {
  const unit = expiry.slice(-1);
  const value = parseInt(expiry.slice(0, -1), 10);
  const map = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };
  return (map[unit] || 86_400_000) * value;
};

// ─── Helper: generate both tokens, persist refresh token, set cookies ─────────
const issueTokens = async (user, res) => {
  const accessToken = generateAccessToken(user);
  const refreshToken = generateRefreshToken(user);

  const expiresAt = new Date(
    Date.now() + parseExpiry(process.env.REFRESH_TOKEN_EXPIRY || '7d')
  );

  // Persist the refresh token (replace old ones for this user to limit active sessions)
  await RefreshToken.deleteMany({ user: user._id });
  await RefreshToken.create({ token: refreshToken, user: user._id, expiresAt });

  // Set as httpOnly cookies
  res.cookie('accessToken', accessToken, {
    ...cookieOptions,
    maxAge: parseExpiry(process.env.ACCESS_TOKEN_EXPIRY || '15m'),
  });
  res.cookie('refreshToken', refreshToken, {
    ...cookieOptions,
    maxAge: parseExpiry(process.env.REFRESH_TOKEN_EXPIRY || '7d'),
  });

  return { accessToken, refreshToken };
};

// ─── POST /signup ─────────────────────────────────────────────────────────────
const signup = asyncHandler(async (req, res) => {
  const { username, email, password } = req.body;

  // Check for existing user (email or username)
  const existing = await User.findOne({ $or: [{ email }, { username }] });
  if (existing) {
    const field = existing.email === email ? 'email' : 'username';
    throw new ApiError(409, `An account with this ${field} already exists`);
  }

  const user = await User.create({ username, email, password });

  const { accessToken, refreshToken } = await issueTokens(user, res);

  const safeUser = { _id: user._id, username: user.username, email: user.email };

  return res.status(201).json(
    new ApiResponse(201, { user: safeUser, accessToken, refreshToken }, 'Account created successfully')
  );
});

// ─── POST /login ──────────────────────────────────────────────────────────────
const login = asyncHandler(async (req, res) => {
  const { email, password } = req.body;

  const user = await User.findOne({ email });

  // Generic message prevents user enumeration
  if (!user || !(await user.comparePassword(password))) {
    throw new ApiError(401, 'Invalid email or password');
  }

  const { accessToken, refreshToken } = await issueTokens(user, res);

  const safeUser = { _id: user._id, username: user.username, email: user.email };

  return res.status(200).json(
    new ApiResponse(200, { user: safeUser, accessToken, refreshToken }, 'Login successful')
  );
});

// ─── POST /refresh-token ──────────────────────────────────────────────────────
const refreshToken = asyncHandler(async (req, res) => {
  const incomingToken =
    req.cookies?.refreshToken || req.body?.refreshToken;

  if (!incomingToken) {
    throw new ApiError(400, 'Refresh token is required');
  }

  // Verify JWT signature / expiry
  let decoded;
  try {
    decoded = jwt.verify(incomingToken, process.env.REFRESH_TOKEN_SECRET);
  } catch (err) {
    if (err.name === 'TokenExpiredError') {
      // Clean up the expired token record
      await RefreshToken.deleteOne({ token: incomingToken });
      throw new ApiError(401, 'Refresh token has expired. Please log in again');
    }
    throw new ApiError(401, 'Invalid refresh token');
  }

  // Verify it exists in the database (detect token reuse)
  const storedToken = await RefreshToken.findOne({ token: incomingToken });
  if (!storedToken) {
    throw new ApiError(401, 'Refresh token has already been used or revoked. Please log in again');
  }

  const user = await User.findById(decoded._id);
  if (!user) {
    await RefreshToken.deleteOne({ token: incomingToken });
    throw new ApiError(401, 'User no longer exists');
  }

  // Rotate: delete the old refresh token and issue a new pair
  await RefreshToken.deleteOne({ token: incomingToken });
  const { accessToken, refreshToken: newRefreshToken } = await issueTokens(user, res);

  return res.status(200).json(
    new ApiResponse(
      200,
      { accessToken, refreshToken: newRefreshToken },
      'Tokens refreshed successfully'
    )
  );
});

// ─── POST /logout ─────────────────────────────────────────────────────────────
// Revokes the refresh token so it cannot be used again. Idempotent: an unknown token is not an error.
const logout = asyncHandler(async (req, res) => {
  const incomingToken = req.cookies?.refreshToken || req.body?.refreshToken;
  if (incomingToken) await RefreshToken.deleteOne({ token: incomingToken });

  res.clearCookie('accessToken', cookieOptions);
  res.clearCookie('refreshToken', cookieOptions);
  return res.status(200).json(new ApiResponse(200, null, 'Logged out'));
});

// ─── POST /forgot-password ────────────────────────────────────────────────────
// Answers the same way whether or not the account exists (no user enumeration).
const forgotPassword = asyncHandler(async (req, res) => {
  await passwordResetService.requestReset(req.body.email);
  return res.status(200).json(
    new ApiResponse(200, null, 'If that email has an account, a reset code has been sent')
  );
});

// ─── POST /reset-password ─────────────────────────────────────────────────────
const resetPassword = asyncHandler(async (req, res) => {
  const { email, code, password } = req.body;
  await passwordResetService.resetPassword(email, code, password);
  return res.status(200).json(new ApiResponse(200, null, 'Password updated. Please log in'));
});

// ─── GET /me (protected) ──────────────────────────────────────────────────────
const getMe = asyncHandler(async (req, res) => {
  // req.user is already attached (and password-stripped) by verifyJWT middleware
  return res.status(200).json(
    new ApiResponse(200, { user: req.user }, 'User profile retrieved successfully')
  );
});

module.exports = { signup, login, refreshToken, logout, forgotPassword, resetPassword, getMe };
