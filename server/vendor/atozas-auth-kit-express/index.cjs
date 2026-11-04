/* Prebuilt from atozas-auth-kit-express@1.0.0. The published package has no dist/index.js. */
"use strict";
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// ../../auth-kit-inspect/package/src/index.ts
var index_exports = {};
__export(index_exports, {
  Otp: () => Otp_default,
  User: () => User_default,
  createAuthRouter: () => createAuthRouter,
  createRequireAuth: () => createRequireAuth
});
module.exports = __toCommonJS(index_exports);

// ../../auth-kit-inspect/package/src/router.ts
var import_express = require("express");
var import_google_auth_library = require("google-auth-library");

// ../../auth-kit-inspect/package/src/models/User.ts
var import_mongoose = __toESM(require("mongoose"));
var userSchema = new import_mongoose.Schema(
  {
    email: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true
    },
    name: {
      type: String,
      trim: true
    },
    picture: {
      type: String
    },
    provider: {
      type: String,
      enum: ["google", "email"],
      required: true
    },
    googleId: {
      type: String,
      sparse: true,
      unique: true
    }
  },
  {
    timestamps: true
  }
);
var User;
try {
  User = import_mongoose.default.model("User");
} catch {
  User = import_mongoose.default.model("User", userSchema);
}
var User_default = User;

// ../../auth-kit-inspect/package/src/models/Otp.ts
var import_mongoose2 = __toESM(require("mongoose"));
var otpSchema = new import_mongoose2.Schema(
  {
    email: {
      type: String,
      required: true,
      lowercase: true,
      trim: true
    },
    otp: {
      type: String,
      required: true
    },
    expiresAt: {
      type: Date,
      required: true,
      index: { expires: 0 }
      // TTL index - auto delete
    },
    used: {
      type: Boolean,
      default: false
    },
    ipAddress: {
      type: String
    },
    createdAt: {
      type: Date,
      default: Date.now
    }
  },
  {
    timestamps: false
  }
);
var Otp;
try {
  Otp = import_mongoose2.default.model("Otp");
} catch {
  Otp = import_mongoose2.default.model("Otp", otpSchema);
}
var Otp_default = Otp;

// ../../auth-kit-inspect/package/src/utils/tokens.ts
var import_jsonwebtoken = __toESM(require("jsonwebtoken"));
function generateAccessToken(payload, secret, expiresIn = "15m") {
  return import_jsonwebtoken.default.sign(payload, secret, { expiresIn });
}
function generateRefreshToken(payload, secret, expiresIn = "30d") {
  return import_jsonwebtoken.default.sign(payload, secret, { expiresIn });
}
function verifyAccessToken(token, secret) {
  return import_jsonwebtoken.default.verify(token, secret);
}
function verifyRefreshToken(token, secret) {
  return import_jsonwebtoken.default.verify(token, secret);
}

// ../../auth-kit-inspect/package/src/utils/otp.ts
var import_bcryptjs = __toESM(require("bcryptjs"));
function generateOtp(length = 6) {
  const digits = "0123456789";
  let otp = "";
  for (let i = 0; i < length; i++) {
    otp += digits[Math.floor(Math.random() * 10)];
  }
  return otp;
}
async function hashOtp(otp) {
  const salt = await import_bcryptjs.default.genSalt(10);
  return import_bcryptjs.default.hash(otp, salt);
}
async function compareOtp(plainOtp, hashedOtp) {
  return import_bcryptjs.default.compare(plainOtp, hashedOtp);
}

// ../../auth-kit-inspect/package/src/utils/rateLimit.ts
var rateLimitStore = /* @__PURE__ */ new Map();
function checkRateLimit(key, maxAttempts, windowMs) {
  const now = Date.now();
  const entry = rateLimitStore.get(key);
  if (!entry || now > entry.resetAt) {
    const resetAt = now + windowMs;
    rateLimitStore.set(key, { count: 1, resetAt });
    return { allowed: true, remainingAttempts: maxAttempts - 1, resetAt };
  }
  if (entry.count >= maxAttempts) {
    return { allowed: false, remainingAttempts: 0, resetAt: entry.resetAt };
  }
  entry.count++;
  return { allowed: true, remainingAttempts: maxAttempts - entry.count, resetAt: entry.resetAt };
}
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of rateLimitStore.entries()) {
    if (now > entry.resetAt) {
      rateLimitStore.delete(key);
    }
  }
}, 6e4);

// ../../auth-kit-inspect/package/src/middleware/requireAuth.ts
function createRequireAuth(config) {
  return async (req, res, next) => {
    try {
      const authHeader = req.headers.authorization;
      if (!authHeader || !authHeader.startsWith("Bearer ")) {
        return res.status(401).json({ error: "No token provided" });
      }
      const token = authHeader.substring(7);
      try {
        const decoded = verifyAccessToken(token, config.jwtSecret);
        const user = await User_default.findById(decoded.userId);
        if (!user) {
          return res.status(401).json({ error: "User not found" });
        }
        req.user = {
          id: user._id.toString(),
          email: user.email,
          name: user.name,
          picture: user.picture,
          provider: user.provider
        };
        next();
      } catch (error) {
        return res.status(401).json({ error: "Invalid or expired token" });
      }
    } catch (error) {
      return res.status(500).json({ error: "Internal server error" });
    }
  };
}

// ../../auth-kit-inspect/package/src/router.ts
function createAuthRouter(config) {
  const router = (0, import_express.Router)();
  const googleClient = new import_google_auth_library.OAuth2Client(config.googleClientId);
  const accessTokenExpiry = config.accessTokenExpiry || "15m";
  const refreshTokenExpiry = config.refreshTokenExpiry || "30d";
  const otpExpiry = config.otpExpiry || 5;
  const otpLength = config.otpLength || 6;
  const otpRateLimit = config.otpRateLimit || {
    maxAttempts: 3,
    windowMs: 15 * 60 * 1e3
  };
  const cookieOptions = {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    maxAge: 30 * 24 * 60 * 60 * 1e3,
    // 30 days
    ...config.cookieOptions
  };
  const setAuthTokens = (res, userId, email, provider) => {
    const accessToken = generateAccessToken(
      { userId, email, provider },
      config.jwtSecret,
      accessTokenExpiry
    );
    const refreshToken = generateRefreshToken(
      { userId, email, provider },
      config.jwtRefreshSecret,
      refreshTokenExpiry
    );
    res.cookie("refreshToken", refreshToken, cookieOptions);
    return { accessToken, refreshToken };
  };
  router.post("/google", async (req, res) => {
    try {
      const { credential } = req.body;
      if (!credential) {
        return res.status(400).json({ error: "Credential is required" });
      }
      const ticket = await googleClient.verifyIdToken({
        idToken: credential,
        audience: config.googleClientId
      });
      const payload = ticket.getPayload();
      if (!payload || !payload.email) {
        return res.status(400).json({ error: "Invalid token payload" });
      }
      const { email, name, picture, sub: googleId } = payload;
      let user = await User_default.findOne({ email });
      if (!user) {
        user = await User_default.create({
          email,
          name,
          picture,
          provider: "google",
          googleId
        });
      } else if (user.provider === "email") {
        user.googleId = googleId;
        user.name = user.name || name;
        user.picture = user.picture || picture;
        await user.save();
      }
      const { accessToken } = setAuthTokens(res, user._id.toString(), user.email, "google");
      res.json({
        success: true,
        accessToken,
        user: {
          id: user._id.toString(),
          email: user.email,
          name: user.name,
          picture: user.picture,
          provider: user.provider
        }
      });
    } catch (error) {
      console.error("Google auth error:", error);
      res.status(401).json({ error: "Google authentication failed", details: error.message });
    }
  });
  router.post("/email/send-otp", async (req, res) => {
    try {
      const { email } = req.body;
      if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        return res.status(400).json({ error: "Valid email is required" });
      }
      const ipAddress = req.ip || req.socket.remoteAddress || "unknown";
      const rateLimitKey = `otp:${email.toLowerCase()}:${ipAddress}`;
      const rateLimitResult = checkRateLimit(
        rateLimitKey,
        otpRateLimit.maxAttempts,
        otpRateLimit.windowMs
      );
      if (!rateLimitResult.allowed) {
        return res.status(429).json({
          error: "Too many OTP requests",
          retryAfter: Math.ceil((rateLimitResult.resetAt - Date.now()) / 1e3)
        });
      }
      const otp = generateOtp(otpLength);
      const hashedOtp = await hashOtp(otp);
      const expiresAt = new Date(Date.now() + otpExpiry * 60 * 1e3);
      await Otp_default.create({
        email: email.toLowerCase(),
        otp: hashedOtp,
        expiresAt,
        used: false,
        ipAddress
      });
      try {
        await config.sendEmailOtp(email, otp);
      } catch (error) {
        console.error("Failed to send OTP email:", error);
        return res.status(500).json({ error: "Failed to send OTP email" });
      }
      res.json({
        success: true,
        message: "OTP sent to email",
        expiresIn: otpExpiry * 60
        // in seconds
      });
    } catch (error) {
      console.error("Send OTP error:", error);
      res.status(500).json({ error: "Failed to send OTP" });
    }
  });
  router.post("/email/verify-otp", async (req, res) => {
    try {
      const { email, otp } = req.body;
      if (!email || !otp) {
        return res.status(400).json({ error: "Email and OTP are required" });
      }
      const otpDoc = await Otp_default.findOne({
        email: email.toLowerCase(),
        used: false,
        expiresAt: { $gt: /* @__PURE__ */ new Date() }
      }).sort({ createdAt: -1 });
      if (!otpDoc) {
        return res.status(400).json({ error: "Invalid or expired OTP" });
      }
      const isValid = await compareOtp(otp, otpDoc.otp);
      if (!isValid) {
        return res.status(400).json({ error: "Invalid OTP" });
      }
      otpDoc.used = true;
      await otpDoc.save();
      let user = await User_default.findOne({ email: email.toLowerCase() });
      if (!user) {
        user = await User_default.create({
          email: email.toLowerCase(),
          provider: "email"
        });
      }
      const { accessToken } = setAuthTokens(res, user._id.toString(), user.email, "email");
      res.json({
        success: true,
        accessToken,
        user: {
          id: user._id.toString(),
          email: user.email,
          name: user.name,
          picture: user.picture,
          provider: user.provider
        }
      });
    } catch (error) {
      console.error("Verify OTP error:", error);
      res.status(500).json({ error: "Failed to verify OTP" });
    }
  });
  router.post("/refresh", async (req, res) => {
    try {
      const refreshToken = req.cookies.refreshToken;
      if (!refreshToken) {
        return res.status(401).json({ error: "No refresh token provided" });
      }
      try {
        const decoded = verifyRefreshToken(refreshToken, config.jwtRefreshSecret);
        const user = await User_default.findById(decoded.userId);
        if (!user) {
          return res.status(401).json({ error: "User not found" });
        }
        const accessToken = generateAccessToken(
          { userId: user._id.toString(), email: user.email, provider: user.provider },
          config.jwtSecret,
          accessTokenExpiry
        );
        res.json({
          success: true,
          accessToken
        });
      } catch (error) {
        return res.status(401).json({ error: "Invalid or expired refresh token" });
      }
    } catch (error) {
      console.error("Refresh token error:", error);
      res.status(500).json({ error: "Failed to refresh token" });
    }
  });
  router.get("/me", createRequireAuth(config), async (req, res) => {
    try {
      if (!req.user) {
        return res.status(401).json({ error: "Not authenticated" });
      }
      res.json({
        success: true,
        user: req.user
      });
    } catch (error) {
      console.error("Get user error:", error);
      res.status(500).json({ error: "Failed to get user" });
    }
  });
  router.post("/logout", (req, res) => {
    res.clearCookie("refreshToken", cookieOptions);
    res.json({
      success: true,
      message: "Logged out successfully"
    });
  });
  return router;
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  Otp,
  User,
  createAuthRouter,
  createRequireAuth
});
