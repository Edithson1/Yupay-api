'use strict';

const router = require('express').Router();
const auth = require('../middleware/auth');
const c = require('../controllers/contentController');

router.use(auth);

router.get('/', c.list);
router.put('/', c.upsert);

// Generación con IA (map + tip x 4 idiomas) y estado del gating.
router.get('/status', c.status);
router.post('/generate', c.generate);

module.exports = router;
