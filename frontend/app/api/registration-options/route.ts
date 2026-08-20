import { errorResponse } from '../../lib/auth';
import { listActiveRegistrationOptions } from '../../lib/server-registration-options';

export async function GET() {
    try {
        return Response.json({
            success: true,
            data: await listActiveRegistrationOptions(),
        });
    } catch (err) {
        return errorResponse(err);
    }
}
