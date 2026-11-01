const crypto = require('crypto');
const nodemailer = require('nodemailer');
const User = require('../models/User');
const RefreshToken = require('../models/RefreshToken');
const ApiError = require('../utils/apiError');
const logger = require('../utils/logger');

const CODE_TTL_MS = 15 * 60 * 1000;
const MAX_ATTEMPTS = 5;

const hashCode = (email, code) => crypto.createHash('sha256').update(`${email}:${code}`).digest('hex');

function transport() {
  if (!process.env.SMTP_HOST) return null;
  return nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT) || 587,
    secure: Number(process.env.SMTP_PORT) === 465,
    auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } : undefined,
  });
}

async function deliver(email, code) {
  const mailer = transport();
  if (!mailer) {
    if (process.env.NODE_ENV === 'production') {
      logger.error('[passwordReset] SMTP_HOST is not set: reset codes cannot be delivered.');
    } else {
      logger.warn(`[passwordReset] SMTP is not configured. Development reset code for ${email}: ${code}`);
    }
    return;
  }
  await mailer.sendMail({
    from: process.env.SMTP_FROM || process.env.SMTP_USER,
    to: email,
    subject: 'Your SafeTours password reset code',
    text: `Your SafeTours reset code is ${code}. It expires in 15 minutes. If you did not ask for this, ignore this email.`,
  });
}

/** Stores a hashed code with a 15-minute expiry and sends it. An unknown email does nothing, silently. */
async function requestReset(email) {
  const user = await User.findOne({ email });
  if (!user) return;

  const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
  await User.updateOne(
    { _id: user._id },
    { $set: { passwordReset: { codeHash: hashCode(email, code), expiresAt: new Date(Date.now() + CODE_TTL_MS), attempts: 0 } } }
  );

  // A mail failure is logged, not returned: the answer must not reveal whether the account exists.
  await deliver(email, code).catch((err) => logger.error(`[passwordReset] could not send the code: ${err.message}`));
}

/** Sets the new password if the code is right, then signs the user out everywhere. */
async function resetPassword(email, code, password) {
  const invalid = new ApiError(400, 'That code is wrong or has expired. Request a new one.');

  const user = await User.findOne({ email }).select('+passwordReset');
  const reset = user && user.passwordReset;
  if (!reset || !reset.codeHash || new Date(reset.expiresAt).getTime() < Date.now() || reset.attempts >= MAX_ATTEMPTS) {
    throw invalid;
  }

  const given = Buffer.from(hashCode(email, code));
  if (!crypto.timingSafeEqual(given, Buffer.from(reset.codeHash))) {
    await User.updateOne({ _id: user._id }, { $inc: { 'passwordReset.attempts': 1 } });
    throw invalid;
  }

  user.password = password; // hashed by the model's pre-save hook
  user.passwordReset = undefined;
  await user.save();
  await RefreshToken.deleteMany({ user: user._id });
}

module.exports = { requestReset, resetPassword };
