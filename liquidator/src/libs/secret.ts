import fs from "fs";

export function readSecret(secretName) {
  const path = process.env.SECRET_PATH || `/run/secrets/${secretName}`;
  try {
    const str = fs.readFileSync(path, "utf8");
    const json = JSON.parse(str);

    return json.privKey;
  } catch (err) {
    if (err.code !== "ENOENT") {
      console.error(
        `An error occurred while trying to read the secret path: ${path}. Err: ${err}`
      );
    } else {
      console.debug(`Could not find the secret,: ${secretName}. Err: ${err}`);
    }
    return "";
  }
}
