import Vendor from '../models/Vendor.js';
import WifiSecurityConfig from '../models/WifiSecurityConfig.js';
import { createResponse, createErrorResponse } from '../utils/helpers.js';

class VendorController {
  static async getAllVendors(req, res) {
    try {
      const vendors = await Vendor.getAll();
      return res.json(
        createResponse(req.t('vendor.listRetrieved'), vendors)
      );
    } catch (error) {
      console.error('Get all vendors error:', error);
      return res.status(500).json(
        createErrorResponse(req.t('vendor.listFailed'), error.message)
      );
    }
  }

  static async getVendorById(req, res) {
    try {
      const { id } = req.params;
      
      if (!id) {
        return res.status(400).json(
          createErrorResponse(req.t('vendor.idRequired'))
        );
      }

      const vendor = await Vendor.findById(id);
      
      if (!vendor) {
        return res.status(404).json(
          createErrorResponse(req.t('vendor.notFound'))
        );
      }

      return res.json(
        createResponse(req.t('vendor.retrieved'), vendor)
      );
    } catch (error) {
      console.error('Get vendor by ID error:', error);
      return res.status(500).json(
        createErrorResponse(req.t('vendor.getFailed'), error.message)
      );
    }
  }

  static async createVendor(req, res) {
    try {
      const vendorData = req.body;
      
      if (!vendorData.name || !vendorData.manufacturer_patterns || !vendorData.product_patterns) {
        return res.status(400).json(
          createErrorResponse(req.t('vendor.fieldsRequired'))
        );
      }

      const vendorId = await Vendor.create(vendorData);
      // `null` is the model refusing a name this provider already uses. Told
      // apart from a failure on purpose: nothing went wrong, the operator is
      // being asked to pick a name they can find the row by later.
      if (vendorId === null) {
        return res.status(409).json(createErrorResponse(req.t('vendor.nameTaken')));
      }

      return res.status(201).json(
        createResponse(req.t('vendor.created'), { id: vendorId })
      );
    } catch (error) {
      console.error('Create vendor error:', error);
      return res.status(500).json(
        createErrorResponse(req.t('vendor.createFailed'), error.message)
      );
    }
  }

  static async updateVendor(req, res) {
    try {
      const { id } = req.params;
      const vendorData = req.body;
      
      if (!id) {
        return res.status(400).json(
          createErrorResponse(req.t('vendor.idRequired'))
        );
      }

      const updated = await Vendor.update(id, vendorData);

      if (updated === null) {
        return res.status(409).json(createErrorResponse(req.t('vendor.nameTaken')));
      }
      if (!updated) {
        return res.status(404).json(
          createErrorResponse(req.t('vendor.notFound'))
        );
      }

      return res.json(
        createResponse(req.t('vendor.updated'))
      );
    } catch (error) {
      console.error('Update vendor error:', error);
      return res.status(500).json(
        createErrorResponse(req.t('vendor.updateFailed'), error.message)
      );
    }
  }

  static async deleteVendor(req, res) {
    try {
      const { id } = req.params;
      
      if (!id) {
        return res.status(400).json(
          createErrorResponse(req.t('vendor.idRequired'))
        );
      }

      const deleted = await Vendor.delete(id);
      
      if (!deleted) {
        return res.status(404).json(
          createErrorResponse(req.t('vendor.notFound'))
        );
      }

      return res.json(
        createResponse(req.t('vendor.deleted'))
      );
    } catch (error) {
      console.error('Delete vendor error:', error);
      return res.status(500).json(
        createErrorResponse(req.t('vendor.deleteFailed'), error.message)
      );
    }
  }

  static async getAllWifiSecurityConfigs(req, res) {
    try {
      const configs = await WifiSecurityConfig.getAll();
      return res.json(
        createResponse(req.t('wifiConfig.listRetrieved'), configs)
      );
    } catch (error) {
      console.error('Get all WiFi security configs error:', error);
      return res.status(500).json(
        createErrorResponse(req.t('wifiConfig.listFailed'), error.message)
      );
    }
  }

  static async getWifiSecurityConfigById(req, res) {
    try {
      const { id } = req.params;
      
      if (!id) {
        return res.status(400).json(
          createErrorResponse(req.t('wifiConfig.idRequired'))
        );
      }

      const config = await WifiSecurityConfig.getById(id);
      
      if (!config) {
        return res.status(404).json(
          createErrorResponse(req.t('wifiConfig.notFound'))
        );
      }

      return res.json(
        createResponse(req.t('wifiConfig.retrieved'), config)
      );
    } catch (error) {
      console.error('Get WiFi security config by ID error:', error);
      return res.status(500).json(
        createErrorResponse(req.t('wifiConfig.getFailed'), error.message)
      );
    }
  }

  static async getWifiSecurityConfigByProductClass(req, res) {
    try {
      const { productClass } = req.params;

      if (!productClass) {
        return res.status(400).json(
          createErrorResponse(req.t('wifiConfig.productClassRequired'))
        );
      }

      const config = await WifiSecurityConfig.getByProductClass(productClass);

      if (!config) {
        return res.status(404).json(
          createErrorResponse(req.t('wifiConfig.notFoundForProductClass'))
        );
      }

      return res.json(
        createResponse(req.t('wifiConfig.retrieved'), config)
      );
    } catch (error) {
      console.error('Get WiFi security config by product class error:', error);
      return res.status(500).json(
        createErrorResponse(req.t('wifiConfig.getFailed'), error.message)
      );
    }
  }

  static async createWifiSecurityConfig(req, res) {
    try {
      const { product_class, security_types, password_param_path } = req.body;
      
      if (!product_class || !security_types || !password_param_path) {
        return res.status(400).json(
          createErrorResponse(req.t('wifiConfig.fieldsRequired'))
        );
      }

      const configId = await WifiSecurityConfig.create({
        product_class,
        security_types,
        password_param_path
      });
      // `null` is the model refusing a product class this provider already has
      // a config for. Worth a real answer rather than a second row: the WiFi
      // write path reads the FIRST match, so the row added here would never
      // apply, and nothing on screen would say why the old one kept winning.
      if (configId === null) {
        return res.status(409).json(createErrorResponse(req.t('wifiConfig.productClassTaken')));
      }

      return res.status(201).json(
        createResponse(req.t('wifiConfig.created'), { id: configId })
      );
    } catch (error) {
      console.error('Create WiFi security config error:', error);
      return res.status(500).json(
        createErrorResponse(req.t('wifiConfig.createFailed'), error.message)
      );
    }
  }

  static async updateWifiSecurityConfig(req, res) {
    try {
      const { id } = req.params;
      const { product_class, security_types, password_param_path } = req.body;
      
      if (!id) {
        return res.status(400).json(
          createErrorResponse(req.t('wifiConfig.idRequired'))
        );
      }

      if (!product_class || !security_types || !password_param_path) {
        return res.status(400).json(
          createErrorResponse(req.t('wifiConfig.fieldsRequired'))
        );
      }

      const updated = await WifiSecurityConfig.update(id, {
        product_class,
        security_types,
        password_param_path
      });

      if (updated === null) {
        return res.status(409).json(createErrorResponse(req.t('wifiConfig.productClassTaken')));
      }
      if (!updated) {
        return res.status(404).json(
          createErrorResponse(req.t('wifiConfig.notFound'))
        );
      }

      return res.json(
        createResponse(req.t('wifiConfig.updated'))
      );
    } catch (error) {
      console.error('Update WiFi security config error:', error);
      return res.status(500).json(
        createErrorResponse(req.t('wifiConfig.updateFailed'), error.message)
      );
    }
  }

  static async deleteWifiSecurityConfig(req, res) {
    try {
      const { id } = req.params;
      
      if (!id) {
        return res.status(400).json(
          createErrorResponse(req.t('wifiConfig.idRequired'))
        );
      }

      const deleted = await WifiSecurityConfig.delete(id);
      
      if (!deleted) {
        return res.status(404).json(
          createErrorResponse(req.t('wifiConfig.notFound'))
        );
      }

      return res.json(
        createResponse(req.t('wifiConfig.deleted'))
      );
    } catch (error) {
      console.error('Delete WiFi security config error:', error);
      return res.status(500).json(
        createErrorResponse(req.t('wifiConfig.deleteFailed'), error.message)
      );
    }
  }
}

export default VendorController;
