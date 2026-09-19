import { runDatabaseBackup } from "../services/backup.service";

runDatabaseBackup({ force: true })
  .then((result) => {
    console.info(JSON.stringify(result));
    if (result.skipped) process.exitCode = 1;
  })
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
