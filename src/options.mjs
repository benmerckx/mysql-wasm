// Server settings shared by every runtime and by the prebuilt data directory.
// The defaults size buffers for a dedicated server; these suit an embedded one.
export const serverOptions = [
  '--skip-networking', '--skip-log-bin',
  // Without networking, TLS material is unused and slow to generate in Wasm.
  '--tls-version=', '--auto-generate-certs=OFF',
  '--caching-sha2-password-auto-generate-rsa-keys=OFF',
  '--sha256-password-auto-generate-rsa-keys=OFF',
  '--innodb-buffer-pool-size=33554432',
  '--innodb-log-buffer-size=1048576',
  '--innodb-redo-log-capacity=8388608',
  '--temptable-max-ram=67108864',
  '--innodb-read-io-threads=1', '--innodb-write-io-threads=1', '--innodb-purge-threads=1',
];
