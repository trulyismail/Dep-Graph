/**
 * `npm run selfcheck` entrypoint. Delegates to validate.ts, which runs the
 * generator against the real catalog and a synthetic one, then checks
 * golden chains, shape invariants, and generalization. See validate.ts.
 */
import "./validate.js";
