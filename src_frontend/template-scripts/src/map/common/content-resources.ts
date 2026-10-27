export type ContentResources = Set<() => void>;
let currentResources: ContentResources | undefined;

export function ownContentResource(dispose: () => void): void {
  currentResources?.add(dispose);
}

export function withContentResources<T>(resources: ContentResources, action: () => T): T {
  const previous = currentResources;
  currentResources = resources;
  try {
    return action();
  } finally {
    currentResources = previous;
  }
}

export function releaseContentResources(resources: ContentResources): void {
  const disposers = [...resources];
  resources.clear();
  for (const dispose of disposers) dispose();
}
