{
    "name": "Multicurrency",
    "icon": "/poweredbyandy_saas/static/description/icon.png",
    "version": "19.0.1.0.0",
    "category": "Extra Tools",
    "summary": "Multimoneda",
    "author": "Andyengit,Odoo Community Association (OCA)",
    "website": "https://github.com/OCA/l10n-venezuela",
    "depends": ["account", "product"],
    "data": [
        "security/currency_account_security.xml",
        "views/account_move_views.xml",
        "views/res_currency_views.xml"
    ],
    "license": "LGPL-3",
    "installable": True,
    "auto_install": False,
    "post_init_hook": "post_init_hook",
    "assets": {
        "web.assets_backend": [
            "currency_account/static/src/**/*",
        ],
    },
}
