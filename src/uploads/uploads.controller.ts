import { Body, Controller, Get, HttpCode, Param, Post } from '@nestjs/common'
import type { AuthUser } from '../auth/auth-user'
import { CurrentUser } from '../auth/decorators'
import { UploadsService, type UploadIntentRequest } from './uploads.service'

@Controller('v1/uploads')
export class UploadsController {
	constructor(private readonly uploads: UploadsService) {}

	@Post('intent')
	@HttpCode(200)
	intent(@CurrentUser() user: AuthUser, @Body() body: UploadIntentRequest) {
		return this.uploads.createIntent(user, body, '/v1/uploads/intent')
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
