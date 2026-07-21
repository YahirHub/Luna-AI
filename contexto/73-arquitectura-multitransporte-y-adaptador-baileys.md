# 73 — Arquitectura multitransporte y adaptador Baileys

El núcleo usa MessagingTransport y TransportIncomingMessage. Baileys queda aislado en src/transports/baileys, donde viven presencia, simulación de escritura y cola resiliente. message_send detecta rutas y delega el formato al transporte. --transport/LUNA_TRANSPORT seleccionan el runner; por ahora está registrado Baileys y la factoría permite añadir Telegram u otros clientes.
