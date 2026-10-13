import { connect, Channel, ChannelModel, ConfirmChannel } from 'amqplib'

export function requireBrokerUrl(): string {
	const url = process.env.BROKER_URL?.trim()
	if (!url) {
		throw new Error(
			'BROKER_URL is required (Infisical or SKIP_VAULT=1 export)',
		)
	}
	return url
}

/**
 * amqplib 2.x: connect() returns ChannelModel (createChannel/close),
 * not the low-level Connection object.
 */
export async function connectBroker(
	url = requireBrokerUrl(),
): Promise<ChannelModel> {
	return connect(url)
}

export async function createChannel(
	connection: ChannelModel,
): Promise<Channel> {
	return connection.createChannel()
}

export async function createConfirmChannel(
	connection: ChannelModel,
): Promise<ConfirmChannel> {
	return connection.createConfirmChannel()
}
