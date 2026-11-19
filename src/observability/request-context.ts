import { AsyncLocalStorage } from 'node:async_hooks'

export interface RequestContext {
	tenant: string
	userId?: string
	idempotencyKey?: string
}

export const requestContext = new AsyncLocalStorage<RequestContext>()

export function setContextUser(userId: string): void {
	const store = requestContext.getStore()
	if (store) {
		store.userId = userId
	}
}
