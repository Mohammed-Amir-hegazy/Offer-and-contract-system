const express = require('express');

// Express 4 does not catch rejected promises from async handlers; this router forwards them to next().
function asyncRouter() {
  const router = express.Router();
  for (const method of ['get', 'post', 'use']) {
    const original = router[method].bind(router);
    router[method] = (...args) => original(...args.map((h) => (typeof h === 'function' && h.length < 4
      ? (req, res, next) => Promise.resolve(h(req, res, next)).catch(next)
      : h)));
  }
  return router;
}

module.exports = { asyncRouter };
