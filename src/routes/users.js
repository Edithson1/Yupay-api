'use strict';

const router = require('express').Router();
const auth = require('../middleware/auth');
const c = require('../controllers/usersController');

router.use(auth); // todas las rutas de /users requieren JWT

router.get('/me', c.getMe);
router.patch('/me', c.updateMe);

module.exports = router;
