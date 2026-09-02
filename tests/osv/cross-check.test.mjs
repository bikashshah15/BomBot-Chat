// Node's bare test discovery does not collect the required cross-check.mjs filename.
// Import it from a collected file so G3 always executes the authoritative comparison.
import './cross-check.mjs';
