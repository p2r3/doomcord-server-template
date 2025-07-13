const fs = require("node:fs/promises");
const diskusage = require("diskusage");
const { $ } = require("bun");

const INPUT_DURATION = 15;

/**
 * Creates and returns a buffer containing a Doom demo (LMP) file
 * from a character string of inputs.
 *
 * @param {string} inputs String of inputs of choice [wasdqe]
 * @param {number} [episode] Starting episode
 * @param {number} [map] Starting map
 * @return {Int8Array} LMP file buffer
 */
function forgeDemo (inputs, episode = 1, map = 1) {

  inputs = inputs.replaceAll("e", "eee");

  const buffer = new Int8Array(14 + inputs.length * INPUT_DURATION * 4);

  buffer[0] = 109; // Game version
  buffer[1] = 0;   // Skill level (I'm too young to die)
  buffer[2] = episode;
  buffer[3] = map;
  buffer[4] = 0;   // Multiplayer mode
  buffer[5] = 0;   // -respawn flag
  buffer[6] = 0;   // -fast flag
  buffer[7] = 0;   // -nomonsters flag
  buffer[8] = 0;   // Player POV index
  buffer[9] = 1;   // Is player 1 present
  buffer[10] = 0;  // Is player 2 present
  buffer[11] = 0;  // Is player 3 present
  buffer[12] = 0;  // Is player 4 present
  buffer[buffer.length - 1] = 0x80; // Lump end byte

  for (let i = 0; i < inputs.length; i ++) {
    let tic;
    switch (inputs[i]) {
      case "w":
        tic = new Int8Array([50, 0, 0, 0]);
        break;
      case "s":
        tic = new Int8Array([-50, 0, 0, 0]);
        break;
      case "a":
        tic = new Int8Array([0, 0, 1, 0]);
        break;
      case "d":
        tic = new Int8Array([0, 0, -1, 0]);
        break;
      case "q":
        tic = new Int8Array([0, 0, 0, 0b00000001]);
        break;
      case "e":
        tic = new Int8Array([0, 0, 0, 0b00000010]);
        break;
      default:
        break;
    }
    for (let j = 0; j < INPUT_DURATION; j ++) {
      buffer.set(tic, 13 + i * INPUT_DURATION * 4 + j * 4);
    }
  }

  return buffer;

}

/**
 * Utility function, creates a new temporary directory,
 * making sure to avoid collisions, and returns its path.
 *
 * @return {string} Absolute path to new directory
 */
async function createTempDir () {
  const name = Date.now().toString(36) + Math.random().toString(36).slice(2);
  const path = `${__dirname}/tmp/${name}`;
  if (await fs.exists(path)) return await createTempDir();
  await fs.mkdir(path);
  return path;
}

/**
 * Disk space thresholds for clearing cache. These describe
 * remaining disk space, effectively making them negative offsets.
 * High threshold means "clear once free space under this", and
 * low threshold means "when clearing, ensure this much free space".
 */
const CACHE_CLEAR_HIGH_THRESHOLD = 1024 * 1024 * 1024; // 1 GB
const CACHE_CLEAR_LOW_THRESHOLD = 1024 * 1024 * 1024 * 2; // 2 GB
// Sequences up to this length (inclusive) will not be touched
const CACHE_DEPTH_THRESHOLD = 5;

/**
 * Checks remaining disk space and clears cache according to
 * CACHE_CLEAR_HIGH_THRESHOLD and CACHE_CLEAR_LOW_THRESHOLD.
 * This function should never throw, instead failing silently.
 *
 * @param {string} parentDir Path to cache directory
 */
async function clearOldCache (parentDir) {

  // Check whether disk usage exceeds threshold
  let info = diskusage.checkSync(parentDir);
  if (info.free > CACHE_CLEAR_HIGH_THRESHOLD) return;

  const entries = await fs.readdir(parentDir, { withFileTypes: true });

  // Filter for sequences with length over CACHE_DEPTH_THRESHOLD
  const dirs = [];
  for (let entry of entries) {
    // Adding 2 here to account for episode and map digits in file name
    if (entry.isDirectory() && entry.name.length > CACHE_DEPTH_THRESHOLD + 2) {
      const fullPath = `${parentDir}/${entry.name}`;
      try {
        const stats = await fs.stat(fullPath);
        dirs.push({
          fullPath: fullPath,
          birthtime: stats.birthtimeMs
        });
      } catch { }
    }
  }

  if (dirs.length === 0) return;

  // Sort directories by creation date
  dirs.sort(function(a, b) {
    return a.birthtime - b.birthtime;
  });

  // Delete directories until we have enough space or no more to delete
  while (dirs.length > 0) {
    const oldest = dirs.shift();
    try {
      console.log(`Deleting ${oldest.fullPath}...`);
      await fs.rm(oldest.fullPath, { recursive: true, force: true });
      info = diskusage.checkSync(parentDir);
      if (info.free > CACHE_CLEAR_LOW_THRESHOLD) break;
    } catch { /* Fail silently on disk error */ }
  }

}

/**
 * Checks whether the request comes from Discord.
 * The exact implementation is omitted on purpose, for security reasons.
 *
 * @param {Request} req The HTTP request to validate
 * @return {boolean} Whether the request should be accepted
 */
function checkRequestOrigin (req) {
  return true;
}

/**
 * Which save from the head to start the sequence from.
 *
 * This was useful in older prototypes, setting this to
 * anything but 1 probably breaks things now.
 */
const SAVE_THRESHOLD = 1;
// Duration of the output video, in seconds
const VIDEO_DURATION = 3;

// Path to binary for Chocolate Doom fork (https://github.com/p2r3/chocolate-doomcord)
const DOOM_EXECUTABLE = `${__dirname}/chocolate-doomcord/src/chocolate-doom`;

// Futile effort to limit Discord's caching - it doesn't seem to care
const NOCACHE_HEADERS = {
  "Content-Disposition": "inline",
  "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
  "Pragma": "no-cache",
  "Expires": "0"
};

// These keep track of basic statistics
let requestCount = 0;
let renderCount = 0;

/**
 * Main HTTP request handler.
 *
 * @param {Request} req Client HTTP request object
 * @param {boolean} [retry] Indicates second attempt at generating a response
 * @return {Response} Server's HTTP response
 */
async function handleRequest (req, retry = false) {

  // Check whether the request comes from Discord's backend
  const isValid = checkRequestOrigin(req);
  if (!isValid) return new Response("Forbidden", { status: 403 });

  // Increment request count for statistics
  requestCount++;

  // Decode path in URL, omitting any query params
  const url = new URL(req.url);
  const path = url.pathname;

  // Enforce a character limit to prohibit stupidly long sequences
  if (path.length > 220) {
    return new Response(Bun.file(`${__dirname}/messages/charlimit.webp`));
  }
  // haha discord s/e/x
  if (path.includes("i.wxbp")) {
    return new Response(Bun.file(`${__dirname}/messages/doomkisser2.jpg`));
  }
  // Special response for the "starting state"
  if (path === "/i.webp") {
    return new Response(Bun.file(`${__dirname}/messages/start.webp`));
  }
  // No, browser, we do not have a favicon, stop asking
  if (path === "/favicon.ico") {
    return new Response("", { status: 404 });
  }

  // This is where we complain about user error
  // Otherwise, the input part of the URL is quite lenient
  if (!path.endsWith("i.webp")) {
    return new Response(Bun.file(`${__dirname}/messages/404.webp`));
  }

  // Trim leading slash and trailing `i.webp` part
  let inputs = path.slice(1, -6).toLowerCase();
  let episode = 1, map = 1;

  // If a valid 2-digit number is provided, treat it as the episode and map
  if (!isNaN(inputs.slice(0, 2))) {
    // Limit episodes and maps to respective ranges
    episode = Math.max(Math.min(inputs[0], 3), 1);
    map = Math.max(Math.min(inputs[1], 8), 1);
    // Adjust input string to omit these numbers (redundant?)
    inputs = inputs.slice(2);
  }

  // Filter out any remaining invalid characters
  inputs = inputs.replace(/[^wasdqe]/g, "");
  // We can't process a blank input, so just use `e` as placeholder
  if (!inputs) inputs = "e";

  // Construct sequence to load from
  const save = inputs.slice(0, -SAVE_THRESHOLD);
  // Episode + Map string
  const em = `${episode}${map}`;

  const cachePath = `${__dirname}/cache/${em}${inputs}`;
  const outputPathWEBP = `${cachePath}/output.webp`;
  const outputPathMP4 = `${cachePath}/output.mp4`;

  // Check if cached file exists, and if not, process the cache miss
  if (!(await fs.exists(outputPathWEBP))) {
    console.log(`Cache miss for inputs "${inputs}" on E${episode}M${map}`);

    const tmp = await createTempDir();

    const savePathDSG = `${__dirname}/cache/${em}${save}/doomsav0.dsg`;
    const savePathMP4 = `${__dirname}/cache/${em}${save}/output.mp4`;

    // Continuity check - see if we have a file to load from
    if (save && !(await fs.exists(savePathDSG))) {
      await fs.rm(tmp, { recursive: true, force: true });
      return new Response("", { status: 500, headers: NOCACHE_HEADERS });
    }

    // Ensure the cache directory exists
    if (!(await fs.exists(cachePath))) {
      await fs.mkdir(cachePath, { recursive: true });
    }

    const demoPath = `${tmp}/demo.lmp`;
    const renderPath = `${tmp}/render.mp4`;
    const tmpSavePath = `${tmp}/doomsav0.dsg`;
    const newSavePath = `${cachePath}/doomsav0.dsg`;

    // I dislike JS error handling...
    let err = null, err2 = null, stdout = "";

    try {

      // Write the demo file to the temporary directory
      await Bun.write(demoPath, forgeDemo(inputs.slice(-SAVE_THRESHOLD), episode, map));

      try {
        // This is the part that actually runs Doom!
        if (save) {
          const out = await $`SDL_VIDEODRIVER=dummy ${DOOM_EXECUTABLE} -1 -config default.cfg -timedemo "${demoPath}" -savedir "${tmp}" -loadgame ${savePathDSG} -nosound -render "${renderPath}"`.quiet();
          stdout = out.stdout.toString();
        } else {
          const out = await $`SDL_VIDEODRIVER=dummy ${DOOM_EXECUTABLE} -1 -config default.cfg -timedemo "${demoPath}" -savedir "${tmp}" -nosound -render "${renderPath}"`.quiet();
          stdout = out.stdout.toString();
        }
      } catch (e) {
        // The above claims to fail despite "exiting normally"
        // Save the message in case this turns out to be a real error
        err = e;
        // Once we do fail, stdout will also be passed here instead
        stdout = e.stdout.toString();
      }

      try {

        if (save) {
          // Concatenate the video from the previous sequence with this one
          await Bun.write(`${tmp}/concat.txt`, `file '${savePathMP4}'\nfile '${renderPath}'\n`);
          await $`ffmpeg -f concat -safe 0 -i "${tmp}/concat.txt" -c copy "${tmp}/concat.mp4" -y`.quiet();
          // Leave only VIDEO_DURATION seconds from the end of the new video
          await $`ffmpeg -sseof -${VIDEO_DURATION} -i "${tmp}/concat.mp4" -c:v libx264 "${outputPathMP4}" -y`.quiet();
        } else {
          // If there is no prior sequence, just use the rendered video as-is
          await fs.rename(renderPath, outputPathMP4);
        }

        try {
          // Finally, convert the MP4 to a WEBP
          await $`ffmpeg -i "${outputPathMP4}" -q:v 30 "${outputPathWEBP}" -y`.quiet();
        } catch (e) {
          /**
           * Edge case - in certain race conditions, we might be trying
           * to overwrite a WEBP that someone else requested right before us.
           * If this is the case, we should avoid corrupting the previous
           * client's render, and instead just hope that it'll be ready by
           * the time that we serve it (as it should in most cases).
           */
          if (!("stdout" in e)) throw e;
          if (!e.stdout.toString().includes("already exists. Overwrite?")) throw e;
        }

      } catch (e) {
        err2 = e;
        throw e;
      }

      await fs.rename(tmpSavePath, newSavePath);

    } catch (e) {

      // Carefully build an error string, making sure to not fail here, too
      const err1str = err ? (("stdout" in err && "stderr" in err) ? `${err.stdout.toString()}\n${err.stderr.toString()}` : err) : "";
      const err2str = err2 ? (("stdout" in err2 && "stderr" in err2) ? `${err2.stdout.toString()}\n${err2.stderr.toString()}` : err2) : "";
      const errstr = `[${new Date().toISOString()}] retry = ${retry}\n${err1str}\n${err2str}\n\n`;

      // Log the error to console and to file
      console.error(errstr);
      await fs.appendFile("errors.log", errstr);

      // As a last resort, try handling the request one more time from the top
      // If this is already our second attempt, throw an error in shame...
      if (retry) return new Response(Bun.file(`${__dirname}/messages/error.webp`), { headers: NOCACHE_HEADERS });
      return await handleRequest(req, true);

    } finally {
      // Clear temporary directory and check cache size
      await fs.rm(tmp, { recursive: true, force: true });
      await clearOldCache(`${__dirname}/cache`);
    }

    // If we just transitioned, flash the level transition instruction
    // We do this after rendering to let the player continue if they want to
    const mapInfoPath = `${__dirname}/messages/levels/${em}.webp`;
    if (stdout.includes("DOOMCORD G_ExitLevel") && await fs.exists(mapInfoPath)) {
      await fs.copyFile(mapInfoPath, outputPathWEBP);
    }

    // Write statistics to file, asynchronously
    Bun.write("stats.txt", `requests: ${requestCount}\nrenders: ${++renderCount}`);

  } else {
    // If there is a cache hit, we don't actually have to do anything
    // The output path already points to where the cached file would be
    console.log(`Cache hit for inputs "${inputs}" on E${episode}M${map}`);
  }

  // Finally, return the cached/generated WEBP
  return new Response(Bun.file(outputPathWEBP), { headers: NOCACHE_HEADERS });

}

Bun.serve({
  port: 10666,
  idleTimeout: 15, // 5-second headroom over Discord's timeout
  fetch: (req) => handleRequest(req) // Filter just the first argument
});
