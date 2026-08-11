import secrets
import sys
from base64 import b32encode
from datetime import datetime, timedelta, timezone

from fastapi import Depends, HTTPException, Request
from fastapi.security import OAuth2PasswordBearer
from jose import JWTError, jwt
from pyotp import TOTP
from pyotp.utils import build_uri
from qrcode import QRCode

from global_config import AuthType
from helpers import get_env, verify_password
from logger import logger

from ..base import BaseAuth
from ..models import Login, Token

oauth2_scheme = OAuth2PasswordBearer(tokenUrl="api/token", auto_error=False)


class LocalAuth(BaseAuth):
    JWT_ALGORITHM = "HS256"

    def __init__(self, global_config) -> None:
        # Credentials come from environment variables when set (env always
        # wins), otherwise from the stored first-run setup config.
        stored_config = global_config.stored_config or {}
        self.username = get_env("GLOBNOTES_USERNAME") or stored_config.get(
            "username"
        )
        self.password = get_env("GLOBNOTES_PASSWORD")
        self.password_hash = (
            None if self.password else stored_config.get("password_hash")
        )
        self.secret_key = get_env("GLOBNOTES_SECRET_KEY") or stored_config.get(
            "secret_key"
        )
        if (
            not self.username
            or not (self.password or self.password_hash)
            or not self.secret_key
        ):
            logger.error(
                "Login credentials must be provided via environment "
                "variables or the first-run setup wizard."
            )
            sys.exit(1)
        self.username = self.username.lower()
        self.session_expiry_days = get_env(
            "GLOBNOTES_SESSION_EXPIRY_DAYS", default=30, cast_int=True
        )

        # TOTP (env-configured only)
        self.is_totp_enabled = False
        if global_config.auth_type == AuthType.TOTP:
            if not self.password:
                logger.error(
                    "GLOBNOTES_PASSWORD must be set when using TOTP auth."
                )
                sys.exit(1)
            self.is_totp_enabled = True
            self.totp_key = get_env("GLOBNOTES_TOTP_KEY", mandatory=True)
            self.totp_key = b32encode(self.totp_key.encode("utf-8"))
            self.totp = TOTP(self.totp_key)
            self.last_used_totp = None
            self._display_totp_enrolment()

    def login(self, data: Login) -> Token:
        # Check Username
        username_correct = secrets.compare_digest(
            self.username.lower(), data.username.lower()
        )

        # Check Password & TOTP
        if self.is_totp_enabled:
            current_totp = self.totp.now()
            password_correct = secrets.compare_digest(
                self.password + current_totp, data.password
            )
        elif self.password is not None:
            password_correct = secrets.compare_digest(
                self.password, data.password
            )
        else:
            password_correct = verify_password(
                data.password, self.password_hash
            )

        # Raise error if incorrect
        if not (
            username_correct
            and password_correct
            # Prevent TOTP from being reused
            and (
                self.is_totp_enabled is False
                or current_totp != self.last_used_totp
            )
        ):
            raise ValueError("Incorrect login credentials.")
        if self.is_totp_enabled:
            self.last_used_totp = current_totp

        # Create Token
        access_token = self._create_access_token(data={"sub": self.username})
        return Token(access_token=access_token)

    def authenticate(
        self, request: Request, token: str = Depends(oauth2_scheme)
    ):
        # If no token is found in the header, check the cookies
        if token is None:
            token = request.cookies.get("token")
        # Validate the token
        try:
            self._validate_token(token)
        except (JWTError, ValueError):
            raise HTTPException(
                status_code=401,
                detail="Invalid authentication credentials",
                headers={"WWW-Authenticate": "Bearer"},
            )

    def _validate_token(self, token: str) -> bool:
        if token is None:
            raise ValueError
        payload = jwt.decode(
            token, self.secret_key, algorithms=[self.JWT_ALGORITHM]
        )
        username = payload.get("sub")
        if username is None or username.lower() != self.username:
            raise ValueError

    def _create_access_token(self, data: dict):
        to_encode = data.copy()
        expiry_datetime = datetime.now(timezone.utc) + timedelta(
            days=self.session_expiry_days
        )
        to_encode.update({"exp": expiry_datetime})
        encoded_jwt = jwt.encode(
            to_encode, self.secret_key, algorithm=self.JWT_ALGORITHM
        )
        return encoded_jwt

    def _display_totp_enrolment(self):
        # Fix for #237. Remove padding as per spec:
        # https://github.com/google/google-authenticator/wiki/Key-Uri-Format#secret
        unpadded_secret = self.totp_key.rstrip(b"=")
        uri = build_uri(unpadded_secret, self.username, issuer="globnotes")
        qr = QRCode()
        qr.add_data(uri)
        print(
            "\nScan this QR code with your TOTP app of choice",
            "e.g. Authy or Google Authenticator:",
        )
        qr.print_ascii()
        print(
            f"Or manually enter this key: {self.totp.secret.decode('utf-8')}\n"
        )
