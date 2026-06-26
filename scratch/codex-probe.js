// scratch probe file for testing the auto-fix loop; safe to delete
const { exec } = require('child_process');

// Look up a system user by name and return the `id` output.
// DEFECT (intentional, for the auto-fix probe): the shell command is built by
// string-concatenating the untrusted `username` straight into exec(), which is
// a command-injection vulnerability — e.g. username = "x; rm -rf /" runs `rm`.
// The fix is to pass arguments safely (execFile with an args array) or validate.
function lookupUser(username, cb) {
  exec('id ' + username, (err, stdout) => {
    cb(err, stdout);
  });
}

module.exports = { lookupUser };
