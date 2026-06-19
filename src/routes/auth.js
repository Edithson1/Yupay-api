'use strict';

const router = require('express').Router();
const auth = require('../middleware/auth');
const c = require('../controllers/authController');

router.get('/config', c.config); // público: expone Google Client ID, etc.
router.post('/register', c.register);
router.post('/login', c.login);
router.post('/google', c.google); // registro o login con Google vía OAuth web de Supabase (accessToken)
router.post('/google/idtoken', c.googleIdToken); // registro o login con Google NATIVO en Android (idToken + signInWithIdToken)
router.post('/refresh', c.refresh);

// --- Gestión de correo / contraseña (público) ---
router.post('/check-email', c.checkEmail); // ¿el correo ya existe? (evitar repetir / detectar no registrado)
router.post('/resend-verification', c.resendVerification); // reenviar correo de verificación
router.post('/forgot-password', c.forgotPassword); // enviar correo de restablecimiento
router.post('/reset-password', c.resetPassword); // completar cambio de contraseña

// --- Requieren JWT ---
router.post('/logout', auth, c.logout);
router.delete('/account', auth, c.deleteAccount); // eliminar cuenta + todos sus datos

module.exports = router;
