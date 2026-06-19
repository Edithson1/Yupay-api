'use strict';

require('dotenv').config();

const express = require('express');
const helmet = require('helmet');
const cors = require('cors');

const { fail } = require('./utils/helpers');

const authRoutes = require('./routes/auth');
const usersRoutes = require('./routes/users');
const devicesRoutes = require('./routes/devices');
const productsRoutes = require('./routes/products');
const visitsRoutes = require('./routes/visits');
const contentRoutes = require('./routes/content');
const syncRoutes = require('./routes/sync');

const app = express();

// --- Seguridad básica ---
app.use(helmet());
app.use(cors());

// Body grande: profile_picture y audio_base64 llegan en base64, además del batch de /sync/migrate.
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// --- Raíz (público, sin autenticación) ---
app.get('/', (req, res) => res.json({ success: true, message: 'Yupay API running', version: '1.0.0' }));

// --- Healthcheck ---
app.get('/health', (req, res) => res.json({ success: true, data: { status: 'ok', service: 'yupay-turismo-api' } }));

// --- Rutas ---
app.use('/auth', authRoutes);
app.use('/users', usersRoutes);
app.use('/devices', devicesRoutes);
app.use('/products', productsRoutes);
app.use('/visits', visitsRoutes);
app.use('/content', contentRoutes);
app.use('/sync', syncRoutes);

// --- 404 ---
app.use((req, res) => fail(res, 404, `Ruta no encontrada: ${req.method} ${req.originalUrl}`));

// --- Manejador de errores central ---
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error('[ERROR]', err);
  if (res.headersSent) return next(err);

  if (err.type === 'entity.parse.failed') {
    return fail(res, 400, 'JSON inválido en el cuerpo de la petición');
  }
  if (err.type === 'entity.too.large') {
    return fail(res, 413, 'El cuerpo de la petición es demasiado grande');
  }
  return fail(res, 500, err.message || 'Error interno del servidor');
});

// Render (y otros PaaS) inyectan el puerto vía process.env.PORT y exigen escuchar en
// 0.0.0.0 (todas las interfaces), no solo en localhost.
const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || '0.0.0.0';
app.listen(PORT, HOST, () => {
  console.log(`🚀 Yupay Turismo API escuchando en ${HOST}:${PORT}`);
});

module.exports = app;
