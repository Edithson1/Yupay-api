'use strict';

const router = require('express').Router();
const auth = require('../middleware/auth');
const c = require('../controllers/devicesController');

router.use(auth);

router.get('/', c.list);
router.delete('/:id', c.remove);

module.exports = router;
