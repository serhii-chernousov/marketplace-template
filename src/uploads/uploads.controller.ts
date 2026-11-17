import {
	Body,
	Controller,
	Get,
	Headers,
	HttpCode,
	Param,
	Post,
	Res,
} from '@nestjs/common'
import { Response } from 'express'
import type { AuthUser } from '../auth/auth-user'
import { CurrentUser } from '../auth/decorators'
import { UploadsService, type UploadIntentRequest } from './uploads.service'

@Controller('v1/uploads')
export class UploadsController {
	constructor(private readonly uploads: UploadsService) {}

	@Post('intent')
	@HttpCode(200)
	async intent(
		@CurrentUser() user: AuthUser,
		@Headers('idempotency-key') idempotencyKey: string,
		@Body() body: UploadIntentRequest,
		@Res({ passthrough: true }) res: Response,
	) {
		const result = await this.uploads.createIntent(
			user,
			body,
			'/v1/uploads/intent',
			idempotencyKey,
		)
		if (result.replay) {
			res.setHeader('Idempotency-Replay', 'true')
		}
		return result.intent
	}

	@Get(':id/parts')
	parts(@CurrentUser() user: AuthUser, @Param('id') id: string) {
		return this.uploads.uploadParts(user, id, `/v1/uploads/${id}/parts`)
	}

	@Post(':id/commit')
	@HttpCode(200)
	commit(@CurrentUser() user: AuthUser, @Param('id') id: string) {
		return this.uploads.commit(user, id, `/v1/uploads/${id}/commit`)
	}
}
