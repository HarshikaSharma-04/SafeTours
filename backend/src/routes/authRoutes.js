const express = require('express');
const router = express.Router();

const { signup, login, refreshToken, logout, forgotPassword, resetPassword, getMe } = require('../controllers/authController');
const { verifyJWT } = require('../middleware/authMiddleware');
const { validateSignup, validateLogin, validateForgotPassword, validateResetPassword } = require('../validators/authValidator');

// POST /api/auth/signup
router.post('/signup', validateSignup, signup);

// POST /api/auth/login
router.post('/login', validateLogin, login);

// POST /api/auth/refresh-token
router.post('/refresh-token', refreshToken);

// POST /api/auth/logout
router.post('/logout', logout);

// POST /api/auth/forgot-password
router.post('/forgot-password', validateForgotPassword, forgotPassword);

// POST /api/auth/reset-password
router.post('/reset-password', validateResetPassword, resetPassword);

// GET /api/auth/me  (protected)
router.get('/me', verifyJWT, getMe);

module.exports = router;
