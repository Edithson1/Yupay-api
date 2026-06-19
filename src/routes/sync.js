'use strict';

const router = require('express').Router();
const auth = require('../middleware/auth');
const c = require('../controllers/syncController');

router.use(auth); // todas las rutas de /sync requieren JWT (se usa req.user.id)

router.post('/migrate', c.migrate);
router.post('/push', c.push);
router.get('/pull', c.pull);

module.exports = router;
