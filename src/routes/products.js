'use strict';

const router = require('express').Router();
const auth = require('../middleware/auth');
const c = require('../controllers/productsController');

router.use(auth);

router.get('/', c.list);
router.post('/', c.create);
router.put('/:id', c.update);
router.delete('/:id', c.remove);

module.exports = router;
