import { publicRouter, protectedRouter, isKnownValidationError } from './routes/shared.js';
import './routes/auth-admin.routes.js';
import './routes/patient-records.routes.js';
import './routes/patient-portal.routes.js';
import './routes/coordinator-work.routes.js';
import './routes/care-plans.routes.js';
import './routes/apexcare-intake.routes.js';
import './routes/medication-review.routes.js';
import './routes/apexcare-team.routes.js';

export { publicRouter, protectedRouter, isKnownValidationError };
