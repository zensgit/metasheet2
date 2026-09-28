if (process.env.RBAC_OPTIONAL === '1') {
  throw new Error('RBAC_OPTIONAL must stay off')
}
