- A machine's gh login that gh found no token for (gh's "The token in default is invalid", as over ssh to a Windows PC)
  now reads "gh found no token it could read" in list_machines and the gh warning, not "invalid, expired or revoked";
  the ops worker's GitHub route goes to m3, else biscuit, never to a Windows PC, whose Credential Manager login an ssh
  key sign-in cannot read (w5546).
