export class ApiError extends Error {
	constructor(
		message: string,
		public readonly code: string,
		public readonly httpStatus?: number,
	) {
		super(message);
		this.name = "ApiError";
	}
}

export class AuthenticationError extends ApiError {
	constructor(message: string, httpStatus?: number) {
		super(message, "AUTHENTICATION_ERROR", httpStatus);
		this.name = "AuthenticationError";
	}
}

export class ValidationError extends ApiError {
	constructor(message: string, httpStatus?: number) {
		super(message, "VALIDATION_ERROR", httpStatus);
		this.name = "ValidationError";
	}
}

export class ResourceNotFoundError extends ApiError {
	constructor(message: string, httpStatus?: number) {
		super(message, "RESOURCE_NOT_FOUND", httpStatus);
		this.name = "ResourceNotFoundError";
	}
}

/** Übersetzt eine HTTP-Antwort der DB OpenBoards API in einen typisierten Fehler, ohne Secrets zu übernehmen. */
export function errorFromResponse(status: number, bodyText: string): ApiError {
	let detail = bodyText.slice(0, 500);
	try {
		const parsed = JSON.parse(bodyText);
		detail = parsed?.moreInformation ?? parsed?.message ?? parsed?.error?.message ?? detail;
	} catch {
		// Antwort war kein JSON (z. B. XML-Fehlerantwort) -> Rohtext (gekürzt) verwenden
	}
	if (status === 401 || status === 403) {
		return new AuthenticationError(
			`Die DB OpenBoards API hat die Zugangsdaten abgelehnt (HTTP ${status}): ${detail}`,
			status,
		);
	}
	if (status === 404) {
		return new ResourceNotFoundError(`Station oder Ressource nicht gefunden (HTTP ${status}): ${detail}`, status);
	}
	if (status === 400 || status === 422) {
		return new ValidationError(`Ungültige Anfrage an die DB OpenBoards API (HTTP ${status}): ${detail}`, status);
	}
	return new ApiError(`DB OpenBoards API Fehler (HTTP ${status}): ${detail}`, "API_ERROR", status);
}
