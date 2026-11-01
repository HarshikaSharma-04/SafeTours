const mongoose = require('mongoose');
const bcrypt = require('bcrypt');

const userSchema = new mongoose.Schema(
  {
    username: {
      type: String,
      required: [true, 'Username is required'],
      unique: true,
      trim: true,
      lowercase: true,
      minlength: [3, 'Username must be at least 3 characters'],
      index: true,
    },
    email: {
      type: String,
      required: [true, 'Email is required'],
      unique: true,
      trim: true,
      lowercase: true,
      match: [/^\S+@\S+\.\S+$/, 'Please write a valid email address'],
      index: true,
    },
    password: {
      type: String,
      required: [true, 'Password is required'],
      minlength: [6, 'Password must be at least 6 characters'],
    },
    name: { type: String },
    phone: { type: String },
    nationality: { type: String },
    languages: [{ type: String }],
    gender: { type: String },
    dateOfBirth: { type: String },
    profileImage: { type: String },
    bloodGroup: { type: String },
    address: {
      type: Object,
      default: {},
    },
    medicalInfo: {
      type: Object,
      default: {},
    },
    emergencySettings: {
      type: Object,
      default: {},
    },
    // Password reset: only a hash of the 6-digit code is stored. select:false keeps these out of every normal query.
    passwordReset: {
      type: {
        codeHash: { type: String },
        expiresAt: { type: Date },
        attempts: { type: Number, default: 0 },
      },
      select: false,
    },
    // Authorisation role. Promote a user with: npm run user:role -- <email> admin
    role: {
      type: String,
      enum: ['user', 'admin'],
      default: 'user',
    },
  },
  {
    timestamps: true,
    strict: false,
  }
);

// Hash password before saving if it is new or modified
userSchema.pre('save', async function () {
  if (!this.isModified('password')) return;

  const salt = await bcrypt.genSalt(10);
  this.password = await bcrypt.hash(this.password, salt);
});

// Compare password candidate with the hashed password in database
userSchema.methods.comparePassword = async function (candidatePassword) {
  return bcrypt.compare(candidatePassword, this.password);
};

const User = mongoose.model('User', userSchema);

module.exports = User;