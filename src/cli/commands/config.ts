import { loadConfig } from "../../config.ts";

/**
 * Command to display the current configuration as pretty JSON.
 * @param _args - Command line arguments (unused).
 * @returns Exit code 0 on success.
 */
export async function cmdConfig(_args: string[]): Promise<number> {
  const config = await loadConfig();
  console.log(JSON.stringify(config, null, 2));
  return 0;
}
