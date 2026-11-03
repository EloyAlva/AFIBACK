import "dotenv/config";
import { parseConfig } from "./runtime-config.js";
export const config = parseConfig(process.env);
