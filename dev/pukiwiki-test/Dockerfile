# Test PukiWiki for development: the official PukiWiki 1.5.4 (EUC-JP), empty data.
# Admin password: testpass (for local testing only).
FROM php:8.4-apache

ARG PUKIWIKI_ZIP_URL=https://sourceforge.net/projects/pukiwiki/files/1.5.4/pukiwiki-1.5.4_eucjp.zip/download
ARG PUKIWIKI_ZIP_SHA256=111f0b5dada5f5998468c3d2fa7780e4cafe2e496c26ade1c1ee8583f2771aec

RUN apt-get update && apt-get install -y --no-install-recommends unzip curl ca-certificates libonig-dev \
    && docker-php-ext-install mbstring \
    && rm -rf /var/lib/apt/lists/*

RUN curl -fsSL -o /tmp/pukiwiki.zip "$PUKIWIKI_ZIP_URL" \
    && echo "$PUKIWIKI_ZIP_SHA256  /tmp/pukiwiki.zip" | sha256sum -c - \
    && unzip -q /tmp/pukiwiki.zip -d /tmp/pkwk \
    && cp -a /tmp/pkwk/pukiwiki-1.5.4_eucjp/. /var/www/html/ \
    && rm -rf /tmp/pukiwiki.zip /tmp/pkwk

# admin password "testpass" (md5), for the local test wiki only
RUN sed -i "s/^\$adminpass = '{x-php-md5}!';/\$adminpass = '{x-php-md5}179ad45c6ce2cb97cf1029e212046e81';/" /var/www/html/pukiwiki.ini.php \
    && grep -q "179ad45c6ce2cb97cf1029e212046e81" /var/www/html/pukiwiki.ini.php \
    && chown -R www-data:www-data /var/www/html \
    && chmod -R 777 /var/www/html/attach /var/www/html/backup /var/www/html/cache /var/www/html/counter /var/www/html/diff /var/www/html/wiki

# Optional: the Markdown plugin (https://github.com/epochnet/pukiwiki-plugin-markdown).
# Copy its plugin/ directory to dev/pukiwiki-test/plugin/ before building to include it.
COPY plugin/ /var/www/html/plugin/
