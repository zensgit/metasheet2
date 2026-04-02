type PlmHydratedRouteQueryTransitionOptions = {
  previousRouteValue: string
  nextRouteValue: string | undefined
}

export type PlmHydratedRouteQueryTransition =
  | {
    kind: 'apply'
    routeValue: string
  }
  | {
    kind: 'remove'
    removedRouteValue: string
  }
  | {
    kind: 'noop'
  }

export function resolvePlmHydratedRouteQueryTransition(
  options: PlmHydratedRouteQueryTransitionOptions,
): PlmHydratedRouteQueryTransition {
  const previousRouteValue = options.previousRouteValue.trim()

  if (options.nextRouteValue !== undefined) {
    return {
      kind: 'apply',
      routeValue: options.nextRouteValue,
    }
  }

  if (previousRouteValue) {
    return {
      kind: 'remove',
      removedRouteValue: previousRouteValue,
    }
  }

  return {
    kind: 'noop',
  }
}
