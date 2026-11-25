- Windows read fence closes the owner's secrets on LothDesktop (w5749, lothsahn's go): with the read fence `on`, the
  daemon moves the gh login out of Credential Manager into its folder's hosts.yml (checked before the entries are
  deleted) and labels the gh folder and `~\.ssh` No-Read-Up, so a Low worker can read neither. `warn` or `off` takes the
  labels off and moves the login back. Workers with no vault token keep the machine's gh login as GH_TOKEN. Browser
  profiles stay open (their own AppContainer reads them). Other machines: unchanged.
