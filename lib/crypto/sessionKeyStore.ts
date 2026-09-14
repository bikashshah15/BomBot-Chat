import { config } from '../config.ts';
import { FileSessionKeyVault } from './sessionKeys.ts';

export const sessionKeyVault = new FileSessionKeyVault(config.SESSION_KEY_DIRECTORY);
