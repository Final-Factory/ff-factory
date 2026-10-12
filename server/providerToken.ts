// Mint FFBox's connector token (docs/ffbox-connector-contract.md): prints a new token once and keeps only its
// SHA-256, in a file of the secrets folder that config providers.ffbox.tokenSha256File names (w1078). A running server
// reads that file at the connector's next connection attempt.
//   node server/providerToken.ts             new token (the old one stops working)
//   node server/providerToken.ts --revoke    no token: the connector is refused
import { configPath, loadConfig } from './config.ts';
import { setAppConfig } from './appConfig.ts';
import { mintProviderToken } from './providerProtocol.ts';

const cfg = loadConfig();
const arg = process.argv[2];
if (arg === '--revoke') {
  setAppConfig(configPath(), cfg, 'providers.ffbox.token', null);
  console.log('FFBox connector token removed: the connector is refused until a new one is set.');
} else if (arg === undefined) {
  const token = mintProviderToken();
  setAppConfig(configPath(), cfg, 'providers.ffbox.token', token);
  console.log(token);
  console.error(
    `\nThat is FFBox's connector token, shown once; only its SHA-256 is kept, in the secrets folder. Give it to the\n` +
      `connector's owner out of band (it goes in FFBox's secrets file). The connector's next connection must use it.\n` +
      `providers.ffbox.enabled is ${cfg.providers?.ffbox?.enabled === true ? 'true' : 'false: the connector is refused until it is true'}.`,
  );
} else {
  console.error('usage: node server/providerToken.ts [--revoke]');
  process.exit(2);
}
