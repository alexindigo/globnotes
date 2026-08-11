from helpers import CustomBaseModel


class FileCreateResponse(CustomBaseModel):
    filename: str
    url: str
