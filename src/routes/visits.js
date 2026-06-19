'use strict';

const router = require('express').Router();
const auth = require('../middleware/auth');
const c = require('../controllers/visitsController');

router.use(auth);

router.get('/', c.list);
router.post('/', c.create);
router.get('/:id', c.getOne);
router.put('/:id', c.update);
router.delete('/:id', c.remove);

module.exports = router;
